"""Custom Harbor agent that wraps the existing TypeScript conversation executor.

Runs `evals/workflows/run_single_trial.ts` inside the task container for one test case. The
entrypoint reuses the TS conversation executor + MCP client + LLM client and writes an ATIF
trajectory to /logs/agent/trajectory.json. This agent then loads that trajectory through
Harbor's Trajectory model in populate_context_post_run(), which, under `opik harbor run`,
instantiates the Opik-patched Step objects so each turn becomes a nested span, uniformly with
the built-in claude-code harness. The verifier reads the same trajectory file.
"""

from __future__ import annotations

import base64
import json
import shlex
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

APP_DIR = "/app"
ENTRYPOINT = "evals/workflows/run_single_trial.ts"
TRAJECTORY_FILENAME = "trajectory.json"


class TsExecutorAgent(BaseAgent):
    """Thin wrapper around the TS conversation executor entrypoint."""

    SUPPORTS_ATIF: bool = True

    @staticmethod
    @override
    def name() -> str:
        return "ts-executor"

    @override
    def version(self) -> str:
        return "1.0.0"

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        # The prebuilt image already contains node, the built dist/, node_modules, and the
        # eval runner, so there is nothing to install.
        pass

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        agent_dir = EnvironmentPaths.for_os(environment.os).agent_dir.as_posix()
        instruction_b64 = base64.b64encode(instruction.encode("utf-8")).decode("ascii")

        command_parts = [
            f'export PATH="{APP_DIR}/node_modules/.bin:$PATH"',
            f"cd {APP_DIR}",
            (
                f"tsx {ENTRYPOINT}"
                f" --instruction-b64 {instruction_b64}"
                f" --agent-log-dir {shlex.quote(agent_dir)}"
                + (f" --model {shlex.quote(self.model_name)}" if self.model_name else "")
            ),
        ]

        result = await environment.exec(command="; ".join(command_parts), cwd=APP_DIR)
        if result.stdout:
            self.logger.debug(result.stdout)
        if result.return_code != 0:
            # The entrypoint writes a failure trajectory before any non-catastrophic exit, so
            # the verifier still has something to judge. Log and continue rather than abort.
            self.logger.warning(
                "ts-executor entrypoint exited with code %s: %s",
                result.return_code,
                result.stderr,
            )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Load the ATIF trajectory so Opik captures its steps as spans, and record tokens."""
        # Imported here so the module loads even without opik/harbor tracing patched in.
        from harbor.models.trajectories.step import Step

        trajectory_path = Path(self.logs_dir) / TRAJECTORY_FILENAME
        if not trajectory_path.exists():
            self.logger.warning("No ATIF trajectory found at %s", trajectory_path)
            return

        try:
            data = json.loads(trajectory_path.read_text())
            # Construct each Step explicitly (not via Trajectory.model_validate, which bypasses
            # the Python __init__). Under `opik harbor run` the patched Step.__init__ emits one
            # Opik span per step, nested under the trial trace, matching the claude-code harness.
            for step in data.get("steps", []):
                Step(**step)
        except Exception as exc:
            self.logger.warning("Failed to load ATIF trajectory %s: %s", trajectory_path, exc)
            return

        metrics = data.get("final_metrics") or {}
        if metrics.get("total_prompt_tokens") is not None:
            context.n_input_tokens = metrics["total_prompt_tokens"]
        if metrics.get("total_completion_tokens") is not None:
            context.n_output_tokens = metrics["total_completion_tokens"]
