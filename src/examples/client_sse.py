"""
Test Apify MCP Server using SSE client

It is using python client as the typescript one does not support custom headers when connecting to the SSE server.

Install python dependencies (assumes you have python installed):
> pip install requests python-dotenv mcp
"""

import asyncio
import os
from pathlib import Path

import requests
from dotenv import load_dotenv
from mcp.client.session import ClientSession
from mcp.client.sse import sse_client

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

MCP_SERVER_URL = "https://actors-mcp-server.apify.actor"

HEADERS = {"Authorization": f"Bearer {os.getenv('APIFY_TOKEN')}"}

async def run() -> None:

    print("Start MCP Server with Actors",)
    r = requests.get(MCP_SERVER_URL, headers=HEADERS)
    print("MCP Server Response:", r.json(), end="\n\n")

    async with sse_client(url=f"{MCP_SERVER_URL}/sse", timeout=60, headers=HEADERS) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("Available Tools:", tools, end="\n\n")

            if hasattr(tools, "tools") and not tools.tools:
                print("No tools available!")
                return

            result = await session.call_tool("apify/rag-web-browser", { "query": "example.com", "maxResults": 3 })
            print("Tools Call Result:")

            for content in result.content:
                print(content)

asyncio.run(run())
