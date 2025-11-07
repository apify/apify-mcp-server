# MCP tool selection evaluation

Evaluates MCP server tool selection. Phoenix is used only for storing results and visualization.

You can find the results here: https://app.phoenix.arize.com/s/apify

## CI Workflow

The evaluation workflow runs automatically on:
- **Master branch pushes** - for production evaluations (saves CI cycles)
- **PRs with `validated` label** - for testing evaluation changes before merging

To trigger evaluations on a PR, add the `validated` label to your pull request.

## Two evaluation methods

1. **exact match** (`tool-exact-match`) - binary tool name validation
2. **LLM judge** (`tool-selection-llm`) - Phoenix classifier with structured prompt

## Why OpenRouter?

unified API for Gemini, Claude, GPT. no separate integrations needed.

## Judge model

- model: `openai/gpt-4o-mini`
- prompt: structured eval with context + tool definitions
- output: "correct"/"incorrect" → 1.0/0.0 score (and explanation)

## Config (`config.ts`)

```typescript
MODELS_TO_EVALUATE = ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'google/gemini-2.5-flash']
PASS_THRESHOLD = 0.6
TOOL_SELECTION_EVAL_MODEL = 'openai/gpt-4o-mini'
```

## Setup

```bash
export PHOENIX_BASE_URL="your_url"
export PHOENIX_API_KEY="your_key"
export OPENROUTER_API_KEY="your_key"
export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"

npm ci
npm run evals:create-dataset  # one-time
npm run evals:run
```

## Test cases

40+ cases across 7 tool categories: `fetch-actor-details`, `search-actors`, `apify-slash-rag-web-browser`, `search-apify-docs`, `call-actor`, `get-actor-output`, `fetch-apify-docs`

## Output

- Phoenix dashboard with detailed results
- console: pass/fail per model + evaluator
- exit code: 0 = success, 1 = failure

## Adding new test cases

### How to contribute?

1. **Create an issue or PR** with your new test cases
2. **Explain why it should pass** - add a `reference` field with clear reasoning
3. **Test locally** before submitting
4. **Publish** - we'll review and merge

### Test case structure

Each test case in `test-cases.json` has this structure:

```json
{
  "id": "unique-test-id",
  "category": "tool-category",
  "query": "user query text",
  "expectedTools": ["tool-name"],
  "reference": "explanation of why this should pass (optional)",
  "context": "/* conversation history (optional) */"
}
```

### Simple examples

**Basic tool selection:**
```json
{
  "id": "fetch-actor-details-1",
  "category": "fetch-actor-details",
  "query": "What are the details of apify/instagram-scraper?",
  "expectedTools": ["fetch-actor-details"]
}
```

**With reference explanation:**
```json
{
  "id": "fetch-actor-details-3",
  "category": "fetch-actor-details",
  "query": "Scrape details of apify/google-search-scraper",
  "expectedTools": ["fetch-actor-details"],
  "reference": "It should call the fetch-actor-details with the actor ID 'apify/google-search-scraper' and return the actor's documentation."
}
```

### Advanced examples with context

**Multi-step conversation flow:**
```json
{
  "id": "weather-mcp-search-then-call-1",
  "category": "flow",
  "query": "Now, use the mcp to check the weather in Prague, Czechia?",
  "expectedTools": ["call-actor"],
  "context": [
    { "role": "user", "content": "Search for weather MCP server" },
    { "role": "assistant", "content": "I'll help you to do that" },
    { "role": "tool_use", "tool": "search-actors", "input": {"search": "weather mcp", "limit": 5} },
    { "role": "tool_result", "tool_use_id": 12, "content": "Tool 'search-actors' successful, Actor found: jiri.spilka/weather-mcp-server" }
  ]
}
```

# Best practices for tool definitions and evaluation

## Best practices for tool definitions (based on Anthropic's guidelines)

To get the best performance out of Claude when using tools, follow these guidelines:

- **Provide extremely detailed descriptions.**
  This is by far the most important factor in tool performance.
  Your descriptions should explain every detail about the tool, including:
    - What the tool does
    - When it should be used (and when it shouldn’t)
    - What each parameter means and how it affects the tool’s behavior
    - Any important caveats or limitations (e.g., what information the tool does not return if the tool name is unclear)

  The more context you give Claude about your tools, the better it will be at deciding when and how to use them.
  Aim for at least **3–4 sentences per tool description**, and more if the tool is complex.

- **Prioritize descriptions over examples.**
  While you can include examples of how to use a tool in its description or accompanying prompt, this is less important than having a clear and comprehensive explanation of the tool’s purpose and parameters.
  Only add examples **after** you’ve fully developed the description.

## Optimize metadata for OpenAI models

- Name – pair the domain with the action (calendar.create_event).
- Description – start with “Use this when…” and call out disallowed cases (“Do not use for reminders”).
- Parameter docs – describe each argument, include examples, and use enums for constrained values.
- Read-only hint – annotate readOnlyHint: true on tools that never mutate state so ChatGPT can streamline confirmation.
---

## How to analyze and improve a specific tool

To improve a tool, you first need to analyze the **evaluation results** to understand where the problem lies.

1. **Analyze results:**
   Open experiments in **Phoenix**, check specific models, and compare **exact matches** with **LLM-as-judge** results.

2. **Understand the issue:**
   Once you’ve identified the problem, modify the tool description to address it.
   The modification is typically **not straightforward** — you might need to:
    - Update the description
    - Adjust input arguments
    - Add examples or negative examples

   According to Anthropic’s Claude documentation, **the most important part is the tool description and explanation**, not the examples.

3. **Iterate experimentally:**
   The path is not always clear and usually requires experimentation.
   Once you’re happy with your updates, **re-run the experiment**.

4. **Fast iteration:**
   For faster testing:
    - Select a **subset of the test data**
    - Focus on **models that perform poorly**

   Once you fix the problem for one model and data subset, **run it on the complete dataset and across different models.**

   ⚠️ Be aware that fixing one example might break another.

---

## Practical debugging steps

This process is **trial and error**, but following these steps has proven effective:

- **Focus on exact tool match first.**
  If the exact match fails, it’s easier to debug and track.
  LLM-judge comparisons are much harder to interpret and may be inaccurate.

- **Update one tool at a time.**
  Changing multiple tools simultaneously is untraceable and leads to confusion.

- **Debug tools individually, but keep global stability in mind.**
  Ensure changes don’t break other tools.

- **If even one tool consistently fails,** the model might struggle to understand the tool, or your test cases may be incorrect.

- **Isolate during testing:**
  When improving a single tool, **enable only that tool** and make sure all use cases pass with just this tool active.

- **Run multiple models after each change.**
  Different models may behave differently — verify stability across all.

---

## Evaluation and comparison workflow

Use **Phoenix MCP** to:
- Fetch experiment results
- Compare outcomes
- Identify failure patterns

However, **never use an LLM to automatically fix tool descriptions.**
Always make improvements **manually**, based on your understanding of the problem.
LLMs are very likely to worsen the issue instead of fixing it.


# Tool definition patterns

Based on analysis of [Cursor Agent Tools v1.0](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/refs/heads/main/Cursor%20Prompts/Agent%20Tools%20v1.0.json), [Lovable Agent Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Tools.json), and [Claude Code Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Claude%20Code/claude-code-tools.json):

## Tool description vs parameter description

**Tool description** should contain:
- What the tool does (core functionality)
- When to use it (usage context)
- Key limitations (what it doesn't do)
- High-level behavior (how it works conceptually)

**Parameter description** should contain:
- Parameter-specific details (what each parameter does)
- Input constraints (validation rules, formats)
- Usage examples (specific examples for that parameter)
- Parameter-specific guidance (how to use that specific parameter)

## Key patterns

1. **Concise but comprehensive** - Avoid overly verbose descriptions
2. **Semantic clarity** - Use language that matches user intent
3. **Clear separation** - Tool purpose vs parameter-specific guidance
4. **Operational constraints** - State limitations and boundaries
5. **Contextual guidance** - Include usage instructions where relevant

## References

- [Example of a good tool description](https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use#example-of-a-good-tool-description)
- [Cursor Agent Tools v1.0](https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/refs/heads/main/Cursor%20Prompts/Agent%20Tools%20v1.0.json)
- [Lovable Agent Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Lovable/Agent%20Tools.json)
- [Claude Code Tools](https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Claude%20Code/claude-code-tools.json)
- [OpenAI optimize metadata](https://developers.openai.com/apps-sdk/guides/optimize-metadata)

NOTES:

// System prompt - instructions mainly cursor (very similar instructions in copilot)
// https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/Cursor%20Prompts/Agent%20Prompt%20v1.2.txt
// https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools/blob/main/VSCode%20Agent/Prompt.txt

