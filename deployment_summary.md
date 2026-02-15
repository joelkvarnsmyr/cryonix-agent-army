# =============================================================================
# Summary of Changes and Deployment Instructions
# =============================================================================

All preparation tasks for deploying the Cryonix application to a production environment on an Azure VM have been completed. The system is now configured to coexist with OpenClaw, using a single Caddy reverse proxy to manage traffic for both applications.

**Summary of Artifacts Created/Modified:**

1.  **`apps/web/Dockerfile` (Created):**
    *   A multi-stage Dockerfile for the Next.js web application. It builds the app into an optimized, standalone production image.

2.  **`Dockerfile.scripts` (Created):**
    *   A lightweight Dockerfile for the background Node.js scripts (`auto-trader.mjs`, `ws-server.mjs`). It provides a minimal Node.js runtime and installs necessary dependencies.

3.  **`Dockerfile` (Root) (Modified):**
    *   Corrected the `CMD` instruction to properly start the Next.js server (`node server.js`) within its standalone build environment.

4.  **`docker-compose.prod.yml` (Modified):**
    *   **`web` service:** Uses the main `Dockerfile` in the root (which builds `apps/web`).
    *   **`auto-trader` and `ws-server` services:** Now use the new `Dockerfile.scripts`.
    *   **`caddy` service:** Added to act as a central reverse proxy for both Cryonix and OpenClaw.
        *   Uses `network_mode: host` to bind to the VM's network interfaces and access OpenClaw on `localhost:18789`.
        *   The `networks` and `depends_on` entries were removed from the Caddy service, as they are incompatible with `network_mode: host`.

5.  **`.env.prod` (Created):**
    *   A template file for production environment variables, including placeholders for `POSTGRES_PASSWORD`, Binance API keys, and XAI_API_KEY.

6.  **`Caddyfile` (Created & Modified):**
    *   Configures Caddy to serve `cryonix.local` (proxying to the `web` service's port 3000) and `openclaw.local` (proxying to `localhost:18789` where OpenClaw is running).
    *   It's configured for automatic HTTPS using a self-signed certificate for local development, which is suitable for a VM.

---

**Updated Deployment Instructions for your Azure VM**

Follow these steps on your Azure VM to deploy and run the Cryonix application alongside OpenClaw:

1.  **Prerequisites:**
    *   Ensure your Azure VM has **Docker** and **Docker Compose** installed.
    *   Your Tailscale client must be running and connected to your tailnet.

2.  **Clone Cryonix Repository:**
    ```bash
    git clone <your-cryonix-repository-url>
    cd cryonix-agent-army
    ```

3.  **Create and Populate `.env` file:**
    Rename the `.env.prod` template to `.env` and fill in your sensitive information.
    ```bash
    mv .env.prod .env
    nano .env
    # Fill in your POSTGRES_PASSWORD, BINANCE_API_KEY, BINANCE_API_SECRET, XAI_API_KEY
    # You can also set WEB_PORT and WS_PORT if you need custom port mappings.
    ```

4.  **Update `hosts` file (on your local machine for access):**
    To access both applications via their local domains, you need to add entries to your local machine's `hosts` file (not the VM's).
    *   **Find your VM's Tailscale IP:** Run `tailscale status` on your local machine to get the IP for `openclaw-vm` (e.g., `100.81.85.80`).
    *   **Edit your local `hosts` file:**
        *   **Windows:** `C:\Windows\System32\drivers\etc\hosts`
        *   **Linux/macOS:** `/etc/hosts`

    Add these lines, replacing `<YOUR_VM_TAILSCALE_IP>` with the actual IP:
    ```
    <YOUR_VM_TAILSCALE_IP> cryonix.local
    <YOUR_VM_TAILSCALE_IP> openclaw.local
    ```

5.  **Build and Run All Services:**
    Execute the following command from the root of the `cryonix-agent-army` directory on your VM to build and start all containers in the background:
    ```bash
    docker-compose -f docker-compose.prod.yml up --build -d
    ```

**After Deployment:**

*   **Access Cryonix:** Open your web browser and navigate to `https://cryonix.local`.
*   **Access OpenClaw:** Open your web browser and navigate to `https://openclaw.local`.
*   **Monitoring Logs:** You can monitor the logs of all services with `docker-compose -f docker-compose.prod.yml logs -f`. For a specific service (e.g., `web`), use `docker-compose -f docker-compose.prod.yml logs -f web`.
*   **Stopping Services:** To stop all services, run `docker-compose -f docker-compose.prod.yml down`.

This setup centralizes web traffic through Caddy and ensures both Cryonix and OpenClaw can run concurrently on your VM without port conflicts.
