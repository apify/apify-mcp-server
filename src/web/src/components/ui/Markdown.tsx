import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Heading } from "./Heading";
import { Text } from "./Text";

type MarkdownCodeProps = React.ComponentProps<"code"> & { inline?: boolean };

type MarkdownProps = {
    children: string;
};

export const Markdown: React.FC<MarkdownProps> = ({ children }) => {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={{
                h2: ({ children: headingChildren, ...props }) => (
                    <Heading
                        as="h2"
                        size="lg"
                        className="mb-3 [&_a]:text-inherit [&_a]:no-underline [&_code]:px-0 [&_code]:py-0"
                        {...props}
                    >
                        {headingChildren}
                    </Heading>
                ),
                p: ({ children: paragraphChildren, ...props }) => (
                    <Text as="p" size="sm" {...props}>
                        {paragraphChildren}
                    </Text>
                ),
                ul: ({ children: listChildren, ...props }) => (
                    <ul className="list-none pl-0 text-sm leading-6" {...props}>
                        {listChildren}
                    </ul>
                ),
                li: ({ children: listItemChildren, ...props }) => (
                    <li className="mb-1" {...props}>
                        {listItemChildren}
                    </li>
                ),
                a: ({ children: linkChildren, ...props }) => (
                    <a {...props} className="underline text-[var(--color-link)]">
                        {linkChildren}
                    </a>
                ),
                blockquote: ({ children: quoteChildren, ...props }) => (
                    <blockquote
                        {...props}
                        className="border-l-2 border-[var(--color-border)] pl-3"
                    >
                        <Text as="div" size="sm" tone="secondary">
                            {quoteChildren}
                        </Text>
                    </blockquote>
                ),
                code: (props: MarkdownCodeProps) => {
                    const { children: codeChildren, ...rest } = props;
                    return (
                        <code
                            {...rest}
                            className="rounded px-1 py-0.5 bg-[var(--color-code-bg)] text-[var(--color-code-text)] align-middle"
                        >
                            {codeChildren}
                        </code>
                    );
                },
            }}
        >
            {children}
        </ReactMarkdown>
    );
};
