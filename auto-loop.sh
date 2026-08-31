#!/usr/bin/env bash
# =============================================================================
# ProjectMind Autonomous Loop Watchdog
#
# Purpose:
#   Keep the OpenCode autonomous orchestrator alive 24/7.
#
# The watchdog itself makes NO engineering decisions.
# All project decisions belong to the orchestrator agent.
#
# Stop:
#   touch .auto-loop.stop
#
# Hard stop:
#   pkill -f auto-loop.sh
#
# =============================================================================

set -u
set -o pipefail

cd "$(dirname "$0")" || exit 1

STOP_FILE=".auto-loop.stop"
LOG_FILE="auto-loop.log"

# How long to wait between OpenCode sessions.
RESTART_DELAY=3

# After repeated failures, use a longer cooldown.
FAILURE_THRESHOLD=5
FAILURE_COOLDOWN=60

# Maximum runtime for one OpenCode invocation.
# 0 = unlimited.
SESSION_TIMEOUT=0

FAIL_COUNT=0
SESSION_COUNT=0

FMT() {
    date +"%Y-%m-%d %H:%M:%S"
}

say() {
    printf '[%s] %s\n' "$(FMT)" "$1" | tee -a "$LOG_FILE"
}

cleanup() {
    say "Watchdog shutting down."
}

trap cleanup EXIT

mkdir -p "$(dirname "$LOG_FILE")"

say "=================================================="
say "ProjectMind autonomous watchdog started"
say "=================================================="

while true; do

    # -------------------------------------------------------------------------
    # Graceful stop
    # -------------------------------------------------------------------------

    if [ -f "$STOP_FILE" ]; then
        say "STOP marker found."
        rm -f "$STOP_FILE"
        exit 0
    fi

    SESSION_COUNT=$((SESSION_COUNT + 1))

    say "--------------------------------------------------"
    say "Starting automation session #$SESSION_COUNT"
    say "--------------------------------------------------"

    # -------------------------------------------------------------------------
    # IMPORTANT:
    #
    # Do NOT tell the orchestrator which phase to execute.
    #
    # The orchestrator owns the state machine.
    # -------------------------------------------------------------------------

    PROMPT='
You are the autonomous ProjectMind orchestrator.

Continue autonomous software engineering.

Do NOT ask the user questions.
Do NOT request approval.
Do NOT wait for confirmation.

First inspect the current ProjectMind state, repository state,
previous reports, and unfinished work.

Then determine the correct next action yourself.

Continue until:
- the current task is completed, OR
- a genuine infrastructure/provider/environment failure prevents progress.

If a task fails:
- diagnose the failure
- retry with an appropriate strategy
- re-plan when necessary
- use another available agent/model when appropriate
- continue working

Do not repeatedly perform the same failed action.

When the current task is complete, immediately select the next
valuable task.

Persist important progress and decisions in the project state so that
another automation session can continue without relying on conversation
memory.

Operate autonomously.
'

    # -------------------------------------------------------------------------
    # Run OpenCode
    #
    # IMPORTANT: Every invocation starts a FRESH session.
    #
    # Do NOT use --continue / --session here. Continuing the same session
    # appends the entire conversation history to every request, which grows
    # unboundedly and eventually blows past the model endpoint's context
    # limit (context errors at ~570K tokens were observed).
    #
    # The orchestrator is instructed to persist progress to the project state
    # on disk, so each fresh session picks up where the previous one left off
    # without relying on conversation memory.
    # -------------------------------------------------------------------------

    say "Launching fresh automation session #$SESSION_COUNT."

    if [ "$SESSION_TIMEOUT" -gt 0 ]; then
        timeout \
            --foreground \
            "$SESSION_TIMEOUT" \
            opencode run \
            --agent orchestrator \
            --auto \
            "$PROMPT" 2>&1 | tee -a "$LOG_FILE"
    else
        opencode run \
            --agent orchestrator \
            --auto \
            "$PROMPT" 2>&1 | tee -a "$LOG_FILE"
    fi

    CODE=${PIPESTATUS[0]}

    say "OpenCode exited with code $CODE."

    # -------------------------------------------------------------------------
    # Success / normal idle exit
    # -------------------------------------------------------------------------

    if [ "$CODE" -eq 0 ]; then
        FAIL_COUNT=0

        say "OpenCode completed normally."
        say "Restarting orchestration in ${RESTART_DELAY}s."

        sleep "$RESTART_DELAY"
        continue
    fi

    # -------------------------------------------------------------------------
    # Failure
    # -------------------------------------------------------------------------

    FAIL_COUNT=$((FAIL_COUNT + 1))

    say "OpenCode failure count: $FAIL_COUNT/$FAILURE_THRESHOLD"

    # Check stop before sleeping.
    if [ -f "$STOP_FILE" ]; then
        say "STOP marker detected after OpenCode failure."
        rm -f "$STOP_FILE"
        exit 0
    fi

    if [ "$FAIL_COUNT" -ge "$FAILURE_THRESHOLD" ]; then
        say "Repeated OpenCode failures."
        say "Entering ${FAILURE_COOLDOWN}s recovery cooldown."

        sleep "$FAILURE_COOLDOWN"

        FAIL_COUNT=0
    else
        sleep "$RESTART_DELAY"
    fi

done