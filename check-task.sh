#!/bin/bash
# Simple completion check script for testing.
# This script checks if a file named "completion-marker" exists.
# Exit code 0 means task is complete, non-zero means not yet finished.

MARKER_FILE="/workspaces/opencode-completion-check-command/completion-marker"

if [ -f "$MARKER_FILE" ]; then
  echo "Task is complete - marker file exists"
  exit 0
else
  echo "Task is NOT complete - marker file does not exist"
  echo "Create the file: $MARKER_FILE"
  exit 1
fi
