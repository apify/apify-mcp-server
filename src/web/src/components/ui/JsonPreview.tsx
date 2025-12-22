import React from "react";

import { Text } from "./Text";

type JsonPreviewProps = {
    value: unknown;
    title?: string;
    maxHeight?: number;
};

export const JsonPreview: React.FC<JsonPreviewProps> = ({ value, title, maxHeight = 300 }) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);

    return (
        <div className="flex flex-col gap-2">
            {title ? (
                <Text as="span" size="xs" weight="medium" tone="secondary">
                    {title}
                </Text>
            ) : null}

            <div
                className="rounded-lg overflow-x-auto bg-[var(--color-card-bg)] border border-[var(--color-border)]"
                style={{
                    maxHeight,
                    overflowY: "auto",
                }}
            >
                <pre className="text-xs whitespace-pre-wrap font-mono p-2 rounded bg-[var(--color-code-bg)]">
                    <code className="text-[var(--color-code-orange)]">{text}</code>
                </pre>
            </div>
        </div>
    );
};
