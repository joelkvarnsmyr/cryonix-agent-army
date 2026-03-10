#!/usr/bin/env python3
"""Fix displayName assignments in UI components to add fallbacks."""
import os
import glob

count = 0
for f in glob.glob("packages/ui/src/components/*.tsx"):
    with open(f) as fh:
        lines = fh.readlines()
    changed = False
    new_lines = []
    for line in lines:
        if ".displayName = " in line and "||" not in line:
            parts = line.split("= ", 1)
            if len(parts) == 2 and ".displayName" in parts[1]:
                stripped = line.rstrip("\n")
                new_lines.append(stripped + ' || "Component"\n')
                changed = True
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)
    if changed:
        with open(f, "w") as fh:
            fh.writelines(new_lines)
        count += 1

print(f"Fixed {count} files")
