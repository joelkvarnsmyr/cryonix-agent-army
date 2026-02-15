#!/usr/bin/env python3
"""
Strategy Lab: Engine Diagnostik

READ-ONLY diagnostic tool for the Cryonix Python engine container.
Parses Docker logs, analyzes crash patterns, checks container health,
and verifies connectivity to dependent services (Redis, Postgres, API).

Usage:
  python3 scripts/strategy-lab/engine_diagnostik.py [--lines 500] [--hours 24]
"""
import argparse
import json
import re
import subprocess
import sys
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta

from tabulate import tabulate

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ENGINE_CONTAINER = "cryonix-engine-1"
ALL_CONTAINERS = [
    "cryonix-engine-1",
    "cryonix-web-1",
    "cryonix-auto-trader-1",
    "cryonix-postgres-1",
    "cryonix-redis-1",
    "cryonix-ws-server-1",
    "cryonix-telegram-bot-1",
    "cryonix-caddy-1",
]
ENGINE_API_URL = "http://localhost:8000"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def run_cmd(cmd: list[str], timeout: int = 15) -> tuple[str, str, int]:
    """Run a shell command and return (stdout, stderr, returncode)."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout, result.stderr, result.returncode
    except subprocess.TimeoutExpired:
        return "", "Command timed out", 1
    except FileNotFoundError:
        return "", f"Command not found: {cmd[0]}", 127


def parse_iso(ts_str: str) -> datetime | None:
    """Parse an ISO 8601 timestamp from Docker inspect."""
    if not ts_str or ts_str.startswith("0001"):
        return None
    try:
        # Docker timestamps may have nanosecond precision; truncate to microseconds
        ts_str = re.sub(r"(\.\d{6})\d+", r"\1", ts_str)
        ts_str = ts_str.rstrip("Z") + "+00:00"
        return datetime.fromisoformat(ts_str)
    except Exception:
        return None


def human_duration(td: timedelta) -> str:
    """Format a timedelta as a human-readable string."""
    total_secs = int(td.total_seconds())
    if total_secs < 0:
        return "N/A"
    days, remainder = divmod(total_secs, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, _ = divmod(remainder, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# 1. Docker Log Parsing
# ---------------------------------------------------------------------------
def fetch_docker_logs(container: str, lines: int) -> str:
    """Fetch the last N lines of docker logs (stdout + stderr merged)."""
    stdout, stderr, rc = run_cmd(
        ["docker", "logs", container, "--tail", str(lines), "--timestamps"],
        timeout=30,
    )
    # Docker sends app stderr to its stderr channel; merge both
    return stdout + "\n" + stderr


def extract_tracebacks(log_text: str) -> list[dict]:
    """
    Extract Python tracebacks from log text.

    Returns a list of dicts with keys: timestamp, error_type, error_message,
    traceback_text, file_line.
    """
    tracebacks = []

    # Pattern: multi-line block starting with 'Traceback (most recent call last):'
    # and ending with the exception line
    tb_pattern = re.compile(
        r"([\dT:.Z\-+]+\s+)?"            # optional timestamp prefix
        r"(Traceback \(most recent call last\):.*?"  # traceback header
        r"(?:^\S.*?Error.*?$|^\S.*?Exception.*?$|^\S.*?Warning.*?$))",  # exception line
        re.MULTILINE | re.DOTALL,
    )

    for match in tb_pattern.finditer(log_text):
        raw = match.group(0).strip()
        timestamp = match.group(1).strip() if match.group(1) else None

        # Extract the final error line
        lines = raw.strip().splitlines()
        error_line = lines[-1].strip() if lines else ""

        # Parse error type and message
        error_type = "UnknownError"
        error_message = error_line
        if ":" in error_line:
            parts = error_line.split(":", 1)
            error_type = parts[0].strip()
            error_message = parts[1].strip() if len(parts) > 1 else ""

        # Extract the last File "..." line for location
        file_line = ""
        for line in reversed(lines):
            if 'File "' in line:
                file_line = line.strip()
                break

        tracebacks.append({
            "timestamp": timestamp,
            "error_type": error_type,
            "error_message": error_message[:200],
            "file_line": file_line[:200],
            "traceback_text": raw[-1000:],  # keep last 1000 chars
        })

    return tracebacks


def extract_error_lines(log_text: str) -> list[dict]:
    """Extract non-traceback error/warning lines from logs."""
    errors = []
    error_re = re.compile(
        r"([\dT:.Z\-+]+\s+)?"
        r".*?(ERROR|CRITICAL|FATAL|WARNING)\b.*",
        re.IGNORECASE,
    )
    for match in error_re.finditer(log_text):
        line = match.group(0).strip()
        # Skip if it looks like it's part of a traceback (indented)
        if line.startswith(" ") or line.startswith("\t"):
            continue
        level = match.group(2).upper() if match.group(2) else "ERROR"
        ts = match.group(1).strip() if match.group(1) else None
        errors.append({
            "timestamp": ts,
            "level": level,
            "message": line[:300],
        })
    return errors


# ---------------------------------------------------------------------------
# 2. Container Health
# ---------------------------------------------------------------------------
def get_container_info(container: str) -> dict:
    """Get container state, uptime, restart count, image via docker inspect."""
    stdout, stderr, rc = run_cmd(
        ["docker", "inspect", container, "--format",
         "{{json .State}}|||{{.RestartCount}}|||{{.Config.Image}}|||{{json .HostConfig.RestartPolicy}}"],
        timeout=10,
    )
    if rc != 0:
        return {"error": stderr.strip() or "Container not found"}

    parts = stdout.strip().split("|||")
    if len(parts) < 4:
        return {"error": "Unexpected inspect output"}

    try:
        state = json.loads(parts[0])
    except json.JSONDecodeError:
        state = {}

    restart_count = parts[1].strip()
    image = parts[2].strip()

    try:
        restart_policy = json.loads(parts[3])
    except json.JSONDecodeError:
        restart_policy = {}

    started_at = parse_iso(state.get("StartedAt", ""))
    finished_at = parse_iso(state.get("FinishedAt", ""))
    now = datetime.now(timezone.utc)

    uptime = None
    if started_at and state.get("Running"):
        uptime = now - started_at

    return {
        "status": state.get("Status", "unknown"),
        "running": state.get("Running", False),
        "oom_killed": state.get("OOMKilled", False),
        "exit_code": state.get("ExitCode", "N/A"),
        "pid": state.get("Pid", "N/A"),
        "started_at": started_at,
        "finished_at": finished_at,
        "uptime": uptime,
        "restart_count": restart_count,
        "restart_policy": restart_policy.get("Name", "unknown"),
        "image": image,
    }


def get_container_stats(container: str) -> dict:
    """Get CPU/memory usage via docker stats (single snapshot)."""
    stdout, stderr, rc = run_cmd(
        ["docker", "stats", container, "--no-stream", "--format",
         "{{.CPUPerc}}|||{{.MemUsage}}|||{{.MemPerc}}|||{{.NetIO}}|||{{.PIDs}}"],
        timeout=15,
    )
    if rc != 0:
        return {"error": stderr.strip()}

    parts = stdout.strip().split("|||")
    if len(parts) < 5:
        return {"error": "Unexpected stats output"}

    return {
        "cpu_pct": parts[0].strip(),
        "mem_usage": parts[1].strip(),
        "mem_pct": parts[2].strip(),
        "net_io": parts[3].strip(),
        "pids": parts[4].strip(),
    }


def get_all_container_statuses() -> list[dict]:
    """Get status of all Cryonix containers."""
    stdout, stderr, rc = run_cmd(
        ["docker", "ps", "-a", "--format",
         "{{.Names}}|||{{.Status}}|||{{.Image}}|||{{.Ports}}",
         "--filter", "name=cryonix-"],
        timeout=10,
    )
    if rc != 0:
        return []

    containers = []
    for line in stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("|||")
        if len(parts) >= 3:
            containers.append({
                "name": parts[0].strip(),
                "status": parts[1].strip(),
                "image": parts[2].strip(),
                "ports": parts[3].strip() if len(parts) > 3 else "",
            })
    return containers


# ---------------------------------------------------------------------------
# 3. Connectivity Checks
# ---------------------------------------------------------------------------
def check_engine_api() -> dict:
    """Check if the engine API responds (from host via docker exec or curl)."""
    # Try reaching the engine API through the web container's network
    stdout, stderr, rc = run_cmd(
        ["docker", "exec", ENGINE_CONTAINER, "python", "-c",
         "import urllib.request; r = urllib.request.urlopen('http://localhost:8000/health', timeout=5); print(r.status, r.read().decode()[:500])"],
        timeout=15,
    )
    if rc == 0 and stdout.strip():
        return {"reachable": True, "response": stdout.strip()[:300]}

    # Fallback: try /docs or root
    stdout2, stderr2, rc2 = run_cmd(
        ["docker", "exec", ENGINE_CONTAINER, "python", "-c",
         "import urllib.request; r = urllib.request.urlopen('http://localhost:8000/', timeout=5); print(r.status)"],
        timeout=15,
    )
    if rc2 == 0:
        return {"reachable": True, "response": f"Root responded: {stdout2.strip()[:200]}"}

    return {
        "reachable": False,
        "error": (stderr or stderr2 or "No response").strip()[:300],
    }


def check_redis_connectivity() -> dict:
    """Check Redis connectivity using the shared db helper."""
    try:
        r = get_redis()
        ping = r.ping()
        # Gather some key stats
        info = {}
        try:
            pending = r.llen("trades:pending")
            info["trades:pending"] = pending
        except Exception:
            pass
        try:
            open_pos = r.llen("positions:open")
            info["positions:open"] = open_pos
        except Exception:
            pass
        try:
            db_size = r.dbsize()
            info["total_keys"] = db_size
        except Exception:
            pass
        r.close()
        return {"connected": True, "ping": ping, "info": info}
    except Exception as e:
        return {"connected": False, "error": str(e)[:300]}


def check_postgres_connectivity() -> dict:
    """Check Postgres connectivity using the shared db helper."""
    try:
        pg = get_pg()
        cur = pg.cursor()
        cur.execute("SELECT 1")
        cur.fetchone()

        # Quick health: table counts
        info = {}
        for table in ["trades", "signals", "positions"]:
            try:
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                count = cur.fetchone()[0]
                info[f"{table}_count"] = count
            except Exception:
                pass

        cur.close()
        pg.close()
        return {"connected": True, "info": info}
    except Exception as e:
        return {"connected": False, "error": str(e)[:300]}


# ---------------------------------------------------------------------------
# 4. Crash Pattern Analysis
# ---------------------------------------------------------------------------
def analyze_crash_patterns(tracebacks: list[dict], hours: int) -> dict:
    """Analyze crash patterns: frequency, common errors, time gaps."""
    if not tracebacks:
        return {"total_crashes": 0}

    error_types = Counter()
    error_messages = Counter()
    file_locations = Counter()
    timestamps = []

    for tb in tracebacks:
        error_types[tb["error_type"]] += 1
        # Normalize message to first 80 chars for grouping
        msg_key = tb["error_message"][:80] if tb["error_message"] else "N/A"
        error_messages[msg_key] += 1
        if tb["file_line"]:
            file_locations[tb["file_line"][:120]] += 1
        if tb["timestamp"]:
            timestamps.append(tb["timestamp"])

    # Calculate time between crashes if we have timestamps
    crash_intervals = []
    if len(timestamps) >= 2:
        parsed_times = []
        for ts in timestamps:
            try:
                clean = re.sub(r"(\.\d{6})\d+", r"\1", ts.rstrip("Z"))
                if "+" not in clean and "-" not in clean[10:]:
                    clean += "+00:00"
                parsed_times.append(datetime.fromisoformat(clean))
            except Exception:
                pass
        parsed_times.sort()
        for i in range(1, len(parsed_times)):
            gap = (parsed_times[i] - parsed_times[i - 1]).total_seconds()
            crash_intervals.append(gap)

    avg_interval = None
    if crash_intervals:
        avg_interval = sum(crash_intervals) / len(crash_intervals)

    return {
        "total_crashes": len(tracebacks),
        "unique_error_types": len(error_types),
        "top_errors": error_types.most_common(10),
        "top_messages": error_messages.most_common(5),
        "top_locations": file_locations.most_common(5),
        "avg_interval_seconds": avg_interval,
        "crash_intervals": crash_intervals,
    }


# ---------------------------------------------------------------------------
# 5. Report Generation
# ---------------------------------------------------------------------------
def generate_report(
    log_text: str,
    tracebacks: list[dict],
    error_lines: list[dict],
    crash_analysis: dict,
    container_info: dict,
    container_stats: dict,
    all_containers: list[dict],
    api_check: dict,
    redis_check: dict,
    pg_check: dict,
    lines: int,
    hours: int,
) -> str:
    """Generate formatted diagnostic report."""
    out = []
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    out.append("=" * 70)
    out.append("  CRYONIX ENGINE DIAGNOSTIK")
    out.append(f"  Container: {ENGINE_CONTAINER}")
    out.append(f"  Log lines analyzed: {lines} | Lookback: {hours}h")
    out.append(f"  Generated: {now}")
    out.append("=" * 70)

    # --- SECTION 1: Container Health ---
    out.append(f"\n  1. CONTAINER HEALTH")
    out.append(f"  {'-'*40}")

    if "error" in container_info:
        out.append(f"  ERROR: {container_info['error']}")
    else:
        health_data = [
            ["Status", container_info["status"].upper()],
            ["Running", "YES" if container_info["running"] else "NO"],
            ["OOM Killed", "YES" if container_info["oom_killed"] else "No"],
            ["Exit Code", container_info["exit_code"]],
            ["PID", container_info["pid"]],
            ["Restart Count", container_info["restart_count"]],
            ["Restart Policy", container_info["restart_policy"]],
            ["Image", container_info["image"]],
        ]
        if container_info["started_at"]:
            health_data.append(
                ["Started At", container_info["started_at"].strftime("%Y-%m-%d %H:%M:%S UTC")]
            )
        if container_info["uptime"]:
            health_data.append(["Uptime", human_duration(container_info["uptime"])])

        out.append(tabulate(health_data, tablefmt="simple"))

        # Warnings
        if container_info["oom_killed"]:
            out.append("  ** WARNING: Container was OOM-killed! Increase memory limit. **")
        if int(container_info.get("restart_count", 0)) > 3:
            out.append(f"  ** WARNING: High restart count ({container_info['restart_count']}). "
                       f"Investigate recurring crashes. **")

    # --- SECTION 2: Resource Usage ---
    out.append(f"\n  2. RESOURCE USAGE")
    out.append(f"  {'-'*40}")

    if "error" in container_stats:
        out.append(f"  Could not fetch stats: {container_stats['error']}")
    else:
        stats_data = [
            ["CPU", container_stats["cpu_pct"]],
            ["Memory", container_stats["mem_usage"]],
            ["Memory %", container_stats["mem_pct"]],
            ["Network I/O", container_stats["net_io"]],
            ["PIDs", container_stats["pids"]],
        ]
        out.append(tabulate(stats_data, tablefmt="simple"))

        # Memory warning
        try:
            mem_pct = float(container_stats["mem_pct"].replace("%", ""))
            if mem_pct > 80:
                out.append(f"  ** WARNING: Memory usage at {mem_pct}%! Risk of OOM. **")
        except ValueError:
            pass

    # --- SECTION 3: Crash Analysis ---
    out.append(f"\n  3. CRASH ANALYSIS (Tracebacks)")
    out.append(f"  {'-'*40}")

    total_crashes = crash_analysis.get("total_crashes", 0)
    out.append(f"  Total tracebacks found: {total_crashes}")

    if total_crashes > 0:
        out.append(f"  Unique error types: {crash_analysis.get('unique_error_types', 0)}")

        if crash_analysis.get("avg_interval_seconds") is not None:
            avg_mins = crash_analysis["avg_interval_seconds"] / 60
            if avg_mins < 60:
                out.append(f"  Avg time between crashes: {avg_mins:.1f} minutes")
            else:
                out.append(f"  Avg time between crashes: {avg_mins/60:.1f} hours")

        # Top error types table
        if crash_analysis.get("top_errors"):
            out.append(f"\n  Top Error Types:")
            err_data = [[et, count] for et, count in crash_analysis["top_errors"]]
            out.append(tabulate(err_data, headers=["Error Type", "Count"], tablefmt="simple"))

        # Top error messages
        if crash_analysis.get("top_messages"):
            out.append(f"\n  Top Error Messages:")
            msg_data = []
            for msg, count in crash_analysis["top_messages"]:
                msg_data.append([msg[:70] + ("..." if len(msg) > 70 else ""), count])
            out.append(tabulate(msg_data, headers=["Message", "Count"], tablefmt="simple"))

        # Top file locations
        if crash_analysis.get("top_locations"):
            out.append(f"\n  Top Crash Locations:")
            loc_data = []
            for loc, count in crash_analysis["top_locations"]:
                loc_data.append([loc[:90] + ("..." if len(loc) > 90 else ""), count])
            out.append(tabulate(loc_data, headers=["Location", "Count"], tablefmt="simple"))

        # Severity assessment
        out.append("")
        if total_crashes > 20:
            out.append("  ** CRITICAL: Very high crash frequency. Engine is unstable. **")
        elif total_crashes > 5:
            out.append("  ** WARNING: Multiple crashes detected. Review error patterns. **")
        else:
            out.append("  INFO: Low crash count. May be transient errors.")

        # Show last 3 tracebacks
        out.append(f"\n  Last {min(3, len(tracebacks))} Traceback(s):")
        for i, tb in enumerate(tracebacks[-3:], 1):
            out.append(f"  --- Traceback #{i} ---")
            if tb["timestamp"]:
                out.append(f"  Time: {tb['timestamp']}")
            out.append(f"  Type: {tb['error_type']}")
            out.append(f"  Msg:  {tb['error_message'][:150]}")
            if tb["file_line"]:
                out.append(f"  At:   {tb['file_line'][:150]}")
            out.append("")
    else:
        out.append("  No Python tracebacks found. Engine appears stable.")

    # --- SECTION 4: Error/Warning Lines ---
    out.append(f"\n  4. LOG ERRORS & WARNINGS")
    out.append(f"  {'-'*40}")

    if error_lines:
        level_counts = Counter(e["level"] for e in error_lines)
        level_data = [[level, count] for level, count in level_counts.most_common()]
        out.append(tabulate(level_data, headers=["Level", "Count"], tablefmt="simple"))

        # Show last 5 error lines
        out.append(f"\n  Last {min(5, len(error_lines))} error/warning lines:")
        for err in error_lines[-5:]:
            ts_prefix = f"[{err['timestamp'][:19]}] " if err["timestamp"] else ""
            out.append(f"  {ts_prefix}{err['level']}: {err['message'][:120]}")
    else:
        out.append("  No ERROR/WARNING lines found in analyzed logs.")

    # --- SECTION 5: Service Connectivity ---
    out.append(f"\n  5. SERVICE CONNECTIVITY")
    out.append(f"  {'-'*40}")

    conn_data = []

    # Engine API
    api_status = "OK" if api_check.get("reachable") else "FAIL"
    api_detail = api_check.get("response", api_check.get("error", ""))[:80]
    conn_data.append(["Engine API (8000)", api_status, api_detail])

    # Redis
    redis_status = "OK" if redis_check.get("connected") else "FAIL"
    redis_detail = ""
    if redis_check.get("connected"):
        info = redis_check.get("info", {})
        parts = []
        for k, v in info.items():
            parts.append(f"{k}={v}")
        redis_detail = ", ".join(parts) if parts else "Connected"
    else:
        redis_detail = redis_check.get("error", "")[:80]
    conn_data.append(["Redis", redis_status, redis_detail])

    # Postgres
    pg_status = "OK" if pg_check.get("connected") else "FAIL"
    pg_detail = ""
    if pg_check.get("connected"):
        info = pg_check.get("info", {})
        parts = []
        for k, v in info.items():
            parts.append(f"{k}={v}")
        pg_detail = ", ".join(parts) if parts else "Connected"
    else:
        pg_detail = pg_check.get("error", "")[:80]
    conn_data.append(["PostgreSQL", pg_status, pg_detail])

    out.append(tabulate(conn_data, headers=["Service", "Status", "Details"], tablefmt="simple"))

    if not api_check.get("reachable"):
        out.append("  ** WARNING: Engine API is not responding. Check if FastAPI is running. **")
    if not redis_check.get("connected"):
        out.append("  ** WARNING: Redis connection failed. Signals queue may be stuck. **")
    if not pg_check.get("connected"):
        out.append("  ** WARNING: Postgres connection failed. Trade persistence broken. **")

    # --- SECTION 6: All Containers Status ---
    out.append(f"\n  6. ALL CRYONIX CONTAINERS")
    out.append(f"  {'-'*40}")

    if all_containers:
        container_data = []
        for c in sorted(all_containers, key=lambda x: x["name"]):
            status = c["status"]
            # Determine health indicator
            if "Up" in status:
                health = "UP"
            elif "Exited" in status:
                health = "DOWN"
            elif "Restarting" in status:
                health = "RESTART"
            else:
                health = "???"
            container_data.append([c["name"], health, status[:40], c["image"][:30]])
        out.append(tabulate(container_data,
                            headers=["Container", "Health", "Status", "Image"],
                            tablefmt="simple"))

        down_containers = [c["name"] for c in all_containers
                           if "Up" not in c["status"]]
        if down_containers:
            out.append(f"\n  ** WARNING: Containers DOWN: {', '.join(down_containers)} **")
    else:
        out.append("  Could not fetch container list.")

    # --- SECTION 7: Diagnosis Summary ---
    out.append(f"\n  {'='*60}")
    out.append(f"  DIAGNOSIS SUMMARY")
    out.append(f"  {'='*60}")

    issues = []
    recommendations = []

    # Issue: container not running
    if not container_info.get("running", False):
        issues.append("Engine container is NOT running.")
        recommendations.append(
            "Restart: docker compose -f docker-compose.prod.yml up -d engine"
        )

    # Issue: OOM
    if container_info.get("oom_killed"):
        issues.append("Container was killed by OOM (Out of Memory).")
        recommendations.append(
            "Increase memory limit in docker-compose.prod.yml or reduce "
            "concurrent scans."
        )

    # Issue: high restart count
    try:
        rc = int(container_info.get("restart_count", 0))
        if rc > 5:
            issues.append(f"High restart count ({rc}). Container is crash-looping.")
            recommendations.append(
                "Check logs for recurring errors. May need code fix or dependency update."
            )
    except (ValueError, TypeError):
        pass

    # Issue: crashes
    if total_crashes > 10:
        top_error = crash_analysis["top_errors"][0] if crash_analysis.get("top_errors") else None
        issues.append(
            f"{total_crashes} Python tracebacks detected"
            + (f" (most common: {top_error[0]}, {top_error[1]}x)" if top_error else "")
            + "."
        )
        recommendations.append(
            "Focus on the most frequent error type. Check if it's a transient "
            "network issue or a code bug."
        )
    elif total_crashes > 0:
        issues.append(f"{total_crashes} Python traceback(s) detected (low severity).")

    # Issue: API down
    if not api_check.get("reachable"):
        issues.append("Engine API (port 8000) is not responding.")
        recommendations.append(
            "Verify FastAPI is starting correctly. Check for import errors "
            "or port conflicts."
        )

    # Issue: Redis down
    if not redis_check.get("connected"):
        issues.append("Redis connection failed from host.")
        recommendations.append("Check if cryonix-redis-1 is running and port 6379 is accessible.")

    # Issue: Postgres down
    if not pg_check.get("connected"):
        issues.append("Postgres connection failed from host.")
        recommendations.append("Check if cryonix-postgres-1 is running and port 5432 is accessible.")

    # Issue: high memory
    try:
        mem_pct = float(container_stats.get("mem_pct", "0%").replace("%", ""))
        if mem_pct > 80:
            issues.append(f"Memory usage at {mem_pct}% -- risk of OOM kill.")
            recommendations.append(
                "Profile memory usage. Check for data leaks in CCXT caching "
                "or pandas DataFrames."
            )
    except (ValueError, TypeError):
        pass

    if not issues:
        out.append("  All checks passed. Engine appears healthy.")
    else:
        for i, issue in enumerate(issues, 1):
            out.append(f"  [{i}] ISSUE: {issue}")
        if recommendations:
            out.append("")
            for i, rec in enumerate(recommendations, 1):
                out.append(f"  [{i}] FIX: {rec}")

    out.append("")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Cryonix Engine Diagnostik -- READ-ONLY diagnostic tool"
    )
    parser.add_argument(
        "--lines", type=int, default=500,
        help="Number of log lines to analyze (default: 500)",
    )
    parser.add_argument(
        "--hours", type=int, default=24,
        help="Lookback period in hours (default: 24)",
    )
    parser.add_argument(
        "--save", type=str, default=None,
        help="Save report to file",
    )
    args = parser.parse_args()

    # 1. Fetch and parse Docker logs
    log_text = fetch_docker_logs(ENGINE_CONTAINER, args.lines)
    tracebacks = extract_tracebacks(log_text)
    error_lines = extract_error_lines(log_text)

    # 2. Analyze crash patterns
    crash_analysis = analyze_crash_patterns(tracebacks, args.hours)

    # 3. Container health
    container_info = get_container_info(ENGINE_CONTAINER)
    container_stats = get_container_stats(ENGINE_CONTAINER)

    # 4. All container statuses
    all_containers = get_all_container_statuses()

    # 5. Connectivity checks
    api_check = check_engine_api()
    redis_check = check_redis_connectivity()
    pg_check = check_postgres_connectivity()

    # 6. Generate report
    report = generate_report(
        log_text=log_text,
        tracebacks=tracebacks,
        error_lines=error_lines,
        crash_analysis=crash_analysis,
        container_info=container_info,
        container_stats=container_stats,
        all_containers=all_containers,
        api_check=api_check,
        redis_check=redis_check,
        pg_check=pg_check,
        lines=args.lines,
        hours=args.hours,
    )

    print(report)

    if args.save:
        with open(args.save, "w") as f:
            f.write(report)
        print(f"Report saved to {args.save}")


if __name__ == "__main__":
    main()
