#!/usr/bin/env python3
"""
One-time script to create Phoenix dataset from test cases.
Run this once to upload test cases to Phoenix platform and receive a dataset ID.
"""

import json
import os
import sys
from pathlib import Path

import pandas as pd
from phoenix import Client as PhoenixClient

from config import validate_env_vars


def load_test_cases() -> dict:
    """Load test cases from JSON file."""
    test_cases_path = Path(__file__).parent / 'test_cases.json'

    if not test_cases_path.exists():
        print(f'Error: Test cases file not found at {test_cases_path}')
        sys.exit(1)

    with open(test_cases_path, 'r') as f:
        return json.load(f)


def create_dataset():
    """Create Phoenix dataset from test cases."""
    print('Creating Phoenix dataset from test cases...')

    # Validate environment variables
    if not validate_env_vars():
        sys.exit(1)

    # Load test cases
    test_data = load_test_cases()
    test_cases = test_data['test_cases']

    print(f'Loaded {len(test_cases)} test cases')

    # Convert to DataFrame format expected by Phoenix
    dataset_rows = []
    for test_case in test_cases:
        dataset_rows.append(
            {
                'question': test_case['question'],
                'tool_calls': ', '.join(test_case['expected_tools']),
                'category': test_case['category'],
            }
        )

    df = pd.DataFrame(dataset_rows)

    # Initialize Phoenix client
    phoenix_client = PhoenixClient(endpoint=os.getenv('PHOENIX_HOST'))

    # Upload dataset
    dataset_name = f'mcp_tool_calling_ground_truth_v{test_data["version"]}'

    print(f"Uploading dataset '{dataset_name}' to Phoenix...")

    try:
        dataset = phoenix_client.upload_dataset(
            dataframe=df,
            dataset_name=dataset_name,
            input_keys=['question'],
            output_keys=['tool_calls'],
        )
        print(f"Dataset '{dataset_name}' created with ID: {dataset.id}")

    except Exception as e:
        print(f'Error creating dataset: {e}')
        sys.exit(1)


if __name__ == '__main__':
    from dotenv import load_dotenv

    load_dotenv()  # Load environment variables from .env file if present
    create_dataset()
