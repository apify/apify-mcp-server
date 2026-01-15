import React, { useMemo } from "react";
import { ArrowLeft } from "../../components/ui/Icons";
import { formatPricing } from "../../utils/formatting";
import { ActorDetails } from "../../types";
import { Button } from "../../components/ui/Button";
import { ActorCard } from "../../components/actor/ActorCard";
import { Heading } from "../../components/ui/Heading";
import { Text } from "../../components/ui/Text";
import { Card } from "../../components/ui/Card";

interface ActorSearchDetailProps {
    details: ActorDetails;
    onBackToList: () => void;
    showBackButton?: boolean;
}

type InputSchema = {
    properties?: Record<
        string,
        {
            type?: string;
            description?: string;
            [key: string]: any;
        }
    >;
};

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details, onBackToList, showBackButton = true }) => {
    const actor = details.actorInfo;

    const pricingText = useMemo(() => {
        return formatPricing(
            actor.currentPricingInfo || {
                pricingModel: "FREE",
                pricePerResultUsd: 0,
                monthlyChargeUsd: 0,
            }
        );
    }, [actor.currentPricingInfo]);

    const readmeLines = useMemo(() => {
        if (!details.readme) return null;
        return details.readme.split("\n");
    }, [details.readme]);

    const inputProps = useMemo(() => {
        const schema = details.inputSchema as unknown as InputSchema | undefined;
        const props = schema?.properties ?? {};
        return Object.entries(props);
    }, [details.inputSchema]);

    return (
        <div className="flex flex-col gap-4 w-full">
            {showBackButton && (
                <Button onClick={onBackToList} variant="secondary" size="md" className="self-start">
                    <ArrowLeft />
                    <span>Back to search results</span>
                </Button>
            )}

            <SectionCard>
                <ActorCard
                    actor={actor}
                    variant="detail"
                    subtitle={`${actor.username}/${actor.name}`}
                    isLast={true}
                    description={actor.description}
                    pricing={pricingText}
                />
            </SectionCard>

            {readmeLines && readmeLines.length > 0 && <DocumentationSection lines={readmeLines} />}

            {inputProps.length > 0 && <InputSchemaSection entries={inputProps.slice(0, 10)} />}

            {details.actorCard && <TechnicalDetailsSection actorCard={details.actorCard} />}
        </div>
    );
};

const SectionCard: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => {
    return (
        <Card variant="default" padding="lg" rounded="3xl" className="w-full" shadow="md">
            {title ? (
                <Heading as="h3" weight="bold" className="mb-4">
                    {title}
                </Heading>
            ) : null}
            {children}
        </Card>
    );
};

const DocumentationSection: React.FC<{ lines: string[] }> = ({ lines }) => {
    const maxLines = 20;
    const visible = lines.slice(0, maxLines);
    const isTruncated = lines.length > maxLines;

    return (
        <SectionCard title="Documentation">
            <Text as="div" size="sm" className="prose max-w-none">
                {visible.map((line, i) => (
                    <p key={i} className="mb-2">
                        {line}
                    </p>
                ))}
                {isTruncated && (
                    <Text as="p" size="sm" tone="secondary" className="italic">
                        ... (truncated for brevity)
                    </Text>
                )}
            </Text>
        </SectionCard>
    );
};

const InputSchemaSection: React.FC<{
    entries: Array<[string, { type?: string; description?: string; [key: string]: any }]>;
}> = ({ entries }) => {
    return (
        <SectionCard title="Input Parameters">
            <div className="space-y-3">
                {entries.map(([key, value]) => (
                    <SchemaFieldRow key={key} name={key} field={value} />
                ))}
            </div>
        </SectionCard>
    );
};

const SchemaFieldRow: React.FC<{
    name: string;
    field: { type?: string; description?: string; [key: string]: any };
}> = ({ name, field }) => {
    return (
        <div className="p-3 rounded-lg bg-[var(--color-code-bg)]">
            <div className="flex items-start gap-2">
                <code className="text-sm font-mono font-semibold text-[var(--color-code-orange)]">
                    {name}
                </code>

                {field.type ? (
                    <span
                        className="text-xs px-2 py-0.5 rounded bg-[var(--color-type-blue-bg)] text-[var(--color-type-blue)]"
                    >
                        {field.type}
                    </span>
                ) : null}
            </div>

            {field.description ? (
                <Text size="sm" tone="secondary" className="mt-1">
                    {field.description}
                </Text>
            ) : null}
        </div>
    );
};

const TechnicalDetailsSection: React.FC<{ actorCard: string }> = ({ actorCard }) => {
    return (
        <SectionCard title="Technical Details">
            <div className="rounded-lg overflow-x-auto p-5 bg-[var(--color-code-bg)] text-[var(--color-code-text)]">
                <pre className="text-xs whitespace-pre-wrap font-mono">
                    <code>{actorCard}</code>
                </pre>
            </div>
        </SectionCard>
    );
};
