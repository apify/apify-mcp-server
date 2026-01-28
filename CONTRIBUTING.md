# Contributing Guidelines

Welcome! This document describes how to contribute to this repository. Following these guidelines helps us maintain a clean history, consistent quality, and smooth review process.
All pull requests are subject to automated and manual review against these guidelines.

---

## 1. Commit Messages and PR Titles

All commits and PR titles must follow the **[Conventional Commits](https://www.conventionalcommits.org/)** format.
Both the **type** (`feat`, `fix`, `chore`, etc.) and the **scope** (the component in parentheses) are required.
To indicate a **breaking change**, append `!` after the scope (e.g., `feat!: ...`).

We use this format to determine version bumps and to generate changelogs.
It applies to both commit messages and PR titles, since PRs are merged using squash and the PR title becomes the commit message.

### Examples of Good Messages

```text
feat: add new tool for fetching actor details
feat!: migrate to new MCP SDK version [internal]
fix: handle connection errors gracefully
refactor: improve type definitions [ignore]
chore: update dependencies
```

---

## 2. Pull Request Descriptions

Your PR description should extend your commit message:
- Explain **what**, **why**, and **how**.
- Mention potential risks.
- Provide instructions for reviewers.
- Link related issues or resources.

---

## 3. Pull Request Comments

Use comments to guide reviewers:
- Flag code that was **just moved**, so they don't re-review it.
- Explain reasoning behind non-obvious changes.
- Highlight extra cleanup or unrelated fixes.

---

## 4. Pull Request Size

- Aim for ≤ **300 lines changed**.
- Large PRs should be split into smaller, focused changes.

---

## 5. Coding Standards & Pitfalls

### Key reminders
*   **Keep logic flat**: avoid deep nesting and unnecessary `else`; return early instead.
*   **Readability first**: small, focused functions and consistent naming.
*   **Error handling**: always handle and propagate errors clearly.
*   **Minimal parameters**: functions should only accept what they actually use.
*   **Reuse utilities**: prefer existing helpers instead of re-implementing logic.
*   **Consistency reinforcement**: rely on the shared ESLint config (`@apify/eslint-config`) and EditorConfig settings to enforce standards automatically.

### Standards
*   **Avoid `else`:** Return early to reduce indentation and keep logic flat.

*   **Naming:** Use full, descriptive names. Avoid single-letter variables except for common loop indices (e.g., `i` for index).
    * **Constants:** When a constant is global (defined at the module's top level), immutable, and optionally exported, use uppercase `SNAKE_CASE` format.
        * If a different applicable naming rule is defined below, that rule takes precedence (e.g., for classes, components, functions, Zod validators, schemas, ...).
    * **Functions & Variables:** Use `camelCase` format.
    * **Classes, Types, Schemas, Components:** Use capitalized `PascalCase` format.
    * **Files & Folders:** Use lowercase `snake_case` format.
    * **Endpoint Paths:** Use lowercase `kebab-case` format.
    * **Booleans:** Prefix with `is`, `has`, or `should` (e.g., `isValid`, `hasFinished`, `shouldRetry`).
    * **Units:** Suffix with the unit of measure (e.g., `externalCostUsd`, `intervalMillis`).
    * **Date/Time:** Suffix with `At` (e.g., `updateStartedAt`, `paidAt`).
    * **Zod Validators:** Suffix with `Validator`.
    * **Text/Copy:** Use the branded term `Actor` (capitalized) instead of `actor` in user-facing texts, labels, notifications, error messages, etc.

*   **Comments:**
    * Use proper English (spelling, grammar, punctuation, capitalization).
    * Use JSDoc `/**` for documentation, `//` for generic comments, and avoid `/*` (single asterix multiline comments).

*   **Parameters**
    * **Minimal Parameters:** Pass only the parameters that the function actually uses.
        * When the parameter is an object (e.g., User), include only the fields used by the function instead of passing full objects with unnecessary data.
        * Use TypeScript generics or utility types to preserve correct typing while narrowing the shape.
            ```typescript
            export const getTransformedUser = <TUser extends FieldsRequiredForGetTransformedUser>(
                user: TUser,
            ): TUser & TransformedUserFields => { /* ... */ };
            ```
    * **Function Parameters:**
        * You may define a function with a comma-separated list of parameters **only if it has up to 3 parameters**.
            ```typescript
            public async getActorBasicInfo(
                actorId: string,
                impersonatedUserId: string,
                token: string
            ): Promise<ActorBasicInfo | null> { /* ... */ };
            ```
        * If the function has **more than 3 parameters**, define it with a **single object parameter** that contains them.
            ```typescript
            private ensureActorAccess = async ({ actorId, userId, token, req }: {
                actorId: string;
                userId: string;
                token: string;
                req: AuthenticatedRequest;
            }) => { /* ... */ };
            ```
        * Optional parameters must be at the end of the list.
    * **Optional Parameters (`?` vs `| undefined`):**
        * Use `?` if calling the function *without* the parameter makes sense.
        * Use `| undefined` if the parameter *should* be passed but might be undefined for a specific reason (e.g., not found).

*   **Async functions**
    * **`await` vs `void`:**
        * Use `await` when you care about the Promise result or exceptions.
        * Use `void` when you don't need to wait for the Promise (e.g., fire-and-forget operations).
    * **Use `return await` when returning Promises:**
        * Ensures that exceptions are thrown within the current function, preserving accurate stack traces and making debugging easier.

*   **Enumerations:**
    * Define as `as const` object instead of TypeScript `enum`.
    * Name both the enumeration object and its keys in singular uppercase `SNAKE_CASE` format.
    * Ensure that each key and its value are identical.
    * Create a TypeScript type with the same name as the enumeration object.
        ```typescript
        export const ACTOR_STATUS = {
            READY: 'READY',
            RUNNING: 'RUNNING',
            SUCCEEDED: 'SUCCEEDED',
        } as const;
        export type ACTOR_STATUS = ValueOf<typeof ACTOR_STATUS>;
        ```

*   **`type` vs `interface`:**
    * Prefer `type` for flexibility.
    * Use `interface` only when it's required for class implementations (`implements`).

*   **Code Structure:**
    * Keep functions short, focused, and cohesive.
    * Declare variables close to their first use.
    * Extract reusable or complex logic into named helper functions.

*   **Immutability:**
    * Avoid mutating function parameters.
    * If mutation is absolutely necessary (e.g., for performance), clearly document and explain it with a comment.

*   **Readability vs. Performance:**
    * Prioritize readability over micro-optimizations.
    * For performance-critical code, optimize only when justified and document the reasoning.

*   **Assertions & Validations:**
    * Use **Zod** for schema-based validation of complex shapes or intricate checks.
    * Use **custom validators and assertions** for lightweight, in-code checks - e.g. validating primitive values, simple shapes, or decision logic inside functions.

*   **Error Handling:**
    * **User Errors:**
        * Use appropriate error codes (4xx for client errors).
        * Log as `softFail` or appropriate level.
    * **Internal Errors:**
        * Use appropriate error codes (5xx for server errors).
        * Log with `log.exception`, `log.error`, or appropriate error logging.

*   **Logging:**
    * Log meaningful information for debugging, especially errors in critical system parts.
    * Use appropriate log levels:
        * `softFail` - client errors
        * `exception` / `error` - server errors
        * `warn` - suspicious but non-critical behavior
        * `info` - progress or important state changes
        * `debug` - local development

*   **Sensitive Data:**
    * Never send sensitive information without proper permission checks.
    * Sanitize data before sending or logging.
    * Use appropriate data structures to limit exposed fields.

---

## 6. Development Setup

For local development setup, scripts, and manual testing, see [DEVELOPMENT.md](./DEVELOPMENT.md).

---

## 7. Code Review Guidelines

- Make **two passes** on substantial PRs:
  - First: understand changes at a high level.
  - Second: focus on details.
- If the PR is too complex, suggest refactoring.
- Use the `important`, `suggestion`, and `nit` keywords to indicate how crucial the comment is.

---

## 8. Testing

- Write tests for new features and bug fixes.
- Ensure all tests pass before submitting a PR.
- Aim for good test coverage, especially for critical paths.
- Use descriptive test names that explain what is being tested.

---

## 9. Documentation

- Update README.md if adding new features or changing behavior.
- Add JSDoc comments for public APIs.
- Keep code comments clear and concise.

---

## 10. Questions?

If you have questions or need help, please:
- Open an issue for discussion
- Check existing issues and PRs
- Review the codebase for examples
