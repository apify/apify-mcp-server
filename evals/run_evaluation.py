#!/usr/bin/env python3
"""
Main evaluation script for MCP tool calling.
"""

import json
import os
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

from anthropic import Anthropic
from openai import OpenAI
from phoenix import Client as PhoenixClient
from phoenix.experiments import run_experiment
from phoenix.experiments.types import Example

from config import MODELS_TO_EVALUATE, SYSTEM_PROMPT, validate_env_vars, DATASET_NAME, PASS_THRESHOLD


def load_tools() -> list[dict[str, Any]]:
    """Load current tool definitions from tools.json."""
    tools_path = Path(__file__).parent.parent / 'evals' / 'tools.json'

    if not tools_path.exists():
        print(f'Error: tools.json not found at {tools_path}')
        print("Run 'npm run evals:export-tools' first to export current tool definitions")
        sys.exit(1)

    with open(tools_path, 'r') as f:
        return json.load(f)

def transform_tools_to_openai_format(tools):
    """ Transforms the tools to the OpenAI format."""
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["inputSchema"],
            },
        }
        for tool in tools
    ]

def transform_tools_to_antrophic_format(tools):
    """ Transforms the tools to the Antrophic format."""
    t = deepcopy(tools)
    for tool_ in t:
        tool_["input_schema"] = tool_.pop("inputSchema")
    return t


def create_openai_task(model_name: str, tools: list[dict[str, Any]]) -> Callable[[Example], list[str]]:
    """Create OpenAI task function with captured metadata."""
    def task(example: Example) -> list[str]:
        client = OpenAI()
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": example.input.get("question")}
        ]

        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            tools=transform_tools_to_openai_format(tools),
        )
        tool_calls = []
        print(example.input.get('question'), response.choices[0].message)
        if response.choices[0].message.tool_calls:
            tool_calls.append(response.choices[0].message.tool_calls[0].function.name)
        return tool_calls

    return task

def create_anthropic_task(model_name: str, tools: list[dict[str, Any]]) -> Callable[[Example], list[str]]:
    """Create Anthropic task function with captured metadata."""
    def task(example: Example) -> list[str]:
        anthropic_client = Anthropic(timeout=10)

        response = anthropic_client.messages.create(
            model=model_name,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user","content": example.input.get("question")}],
            tools=transform_tools_to_antrophic_format(tools),
            max_tokens=2048,
        )

        tool_calls = []
        print(example.input.get('question'), response.content)
        for content in response.content:
            if content.type == 'tool_use':
                tool_calls.append(content.name)
        return tool_calls

    return task


def tools_match(expected: dict, output: list[str]) -> bool:
    """Check if expected tools match actual output."""
    tool_calls = expected.get('tool_calls', '')
    expected_tools = tool_calls.split(', ') if tool_calls else []
    expected_tools = [tool.strip() for tool in expected_tools if tool.strip()]

    return sorted(expected_tools) == sorted(output)


def main():
    """Main evaluation function."""
    print('Starting MCP tool calling evaluation')

    # Validate environment variables
    if not validate_env_vars():
        sys.exit(1)

    # Load tools and dataset info
    tools = load_tools()

    print(f'Loaded {len(tools)} tools')

    # Initialize Phoenix client
    phoenix_client = PhoenixClient()

    # Get dataset
    try:
        dataset = phoenix_client.get_dataset(name=DATASET_NAME)
    except Exception as e:
        print(f'Error loading dataset: {e}')
        sys.exit(1)

    print(f'Loaded dataset "{DATASET_NAME}" with ID: {dataset.id}')
    # Results storage
    results = []

    # Run evaluations for each model
    for model_name in MODELS_TO_EVALUATE:
        print(f'\nEvaluating model: {model_name}')

        # Initialize variables
        accuracy = 0.0
        correct_cases = 0
        total_cases = 0
        experiment_id = None
        error = None

        if model_name.startswith("gpt"):
            task_fnc = create_openai_task(model_name, tools)
        elif model_name.startswith("claude"):
            task_fnc = create_anthropic_task(model_name, tools)
        else:
            print(f'Unknown model type: {model_name}, skipping')
            results.append(
                {'model_name': model_name, 'accuracy': 0.0, 'correct': 0, 'total': 0, 'error': 'Unknown model type'}
            )
            continue

        # Run experiment
        experiment_name = f'MCP tool calling eval {model_name}'
        experiment_description = f'Evaluation of {model_name} on MCP tool calling'

        # try:
        experiment = run_experiment(
            dataset=dataset,
            task=task_fnc,
            evaluators=[tools_match],
            experiment_name=experiment_name,
            experiment_description=experiment_description,
        )

        # Get evaluations and calculate accuracy
        evaluations_df = experiment.get_evaluations()
        total_cases = len(evaluations_df)
        correct_cases = len(evaluations_df[evaluations_df['score'] > 0.5])
        accuracy = correct_cases / total_cases if total_cases > 0 else 0
        experiment_id = experiment.id

        print(f'{model_name}: {accuracy:.1%} ({correct_cases}/{total_cases})')

        # Print sample of evaluations for debugging
        if evaluations_df is not None and len(evaluations_df) > 0:
            print(f'Sample evaluation results:')
            print(evaluations_df[['score', 'label', 'output', 'expected']].to_string())

        # except Exception as e:
        #     print(f'Error evaluating {model_name}: {e}')
        #     error = str(e)

        # Store results
        results.append({
            'model': model_name,
            'accuracy': accuracy,
            'correct': correct_cases,
            'total': total_cases,
            'experiment_id': experiment_id,
            'error': error,
        })

    # Check if all models meet the pass threshold
    all_passed = all(r.get('accuracy', 0) >= PASS_THRESHOLD for r in results if r.get('error') is None)

    print(f'\nPass threshold: {PASS_THRESHOLD:.1%}')
    if all_passed:
        print('✅ All models passed the threshold')
    else:
        print('❌ Some models failed to meet the threshold')

    return 0 if all_passed else 1


if __name__ == '__main__':

    from dotenv import load_dotenv
    load_dotenv()  # Load environment variables from .env file if present

    exit_code = main()
    sys.exit(exit_code)
