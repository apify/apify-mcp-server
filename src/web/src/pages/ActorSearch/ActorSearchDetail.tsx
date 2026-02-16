import React, { useState, useEffect, useRef } from "react";
import styled from "styled-components";
import { Box, Markdown, theme, useActorTitleHeadingFilter, Badge, IconButton, ICON_BUTTON_VARIANTS } from "@apify/ui-library";
import { BookOpenIcon, FullscreenIcon, MinimizeIcon } from "@apify/ui-icons";
import type { ActorDetails } from "../../types";
import { ActorCard } from "../../components/actor/ActorCard";

const FULLSCREEN_WIDTH_THRESHOLD = 900;

type ActorSearchDetailProps = {
    details: ActorDetails;
}

const README_CLASSNAMES = {
    MARKDOWN_WRAPPER: 'Readme-MarkdownWrapper',
    MARKDOWN: 'Readme-Markdown',
    ONELINE_SCROLLABLE_WRAPPER: 'OneLineCode-ScrollableWrapper',
};

const Container = styled(Box)`
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: ${theme.color.neutral.background};
    border-radius: ${theme.radius.radius8};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
`;

const CardWrapper = styled(Box)`
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: 100%;
    max-width: 796px;
`;

const SectionContent = styled(Box)<{ $isExpanded: boolean }>`
    background: ${theme.color.neutral.background};
    border-top: 1px solid ${theme.color.neutral.separatorSubtle};
    color: ${theme.color.neutral.text};
    position: relative;
    display: flex;
    flex-direction: column;

    ${props => props.$isExpanded ? `
        overflow-y: auto;
        max-height: none;
        flex: 1;
    ` : `
        overflow: hidden;
        max-height: 408px;
    `}
`;

const ReadmeWrapper = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space16};
    position: relative;

    .${README_CLASSNAMES.MARKDOWN_WRAPPER} {
        display: flex;
        flex-direction: column;
        gap: ${theme.space.space8};
    }
    /* TODO: this is an exception from the design system, let's figure out how to not do overrides */
    .${README_CLASSNAMES.MARKDOWN} {
        p,
        li,
        strong,
        b,
        table,
        code {
            font-size: 1.2rem;
        }

        ul {
            display: block;
            list-style-type: disc;
            margin-block-start: 1em;
            margin-block-end: 1em;
            padding-inline-start: 40px;
            unicode-bidi: isolate;
        }

        div:not(.${README_CLASSNAMES.ONELINE_SCROLLABLE_WRAPPER}) > pre {
            display: block;
            padding-left: 1.6rem;
            padding-right: 1.6rem;
        }
    }
`;

const GradientOverlay = styled.div`
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 155px;
    background: linear-gradient(178.84deg, transparent 13.4%, ${theme.color.neutral.background} 81.59%);
    pointer-events: none;
    z-index: 1;
`;

const ReadmeHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
`;

const BadgeWrapper = styled.div`
    flex-shrink: 0;
`;

type ReadmeSectionProps = {
    readme: string | null;
    isExpanded: boolean;
    setIsExpanded: (expanded: boolean) => void;
    manuallyCollapsed: React.RefObject<boolean>;
    manuallyExpanded: React.RefObject<boolean>;
}

const ReadmeSection: React.FC<ReadmeSectionProps> = ({ readme, isExpanded, setIsExpanded, manuallyCollapsed, manuallyExpanded }) => {
    const sectionRef = useRef<HTMLDivElement>(null);
    const allowElement = useActorTitleHeadingFilter("Readme");

    // Detect container size changes especially when using third party app's fullscreen close button
    useEffect(() => {
        const section = sectionRef.current;
        if (!section) return;

        const resizeObserver = new ResizeObserver(() => {
            // Check the viewport width (iframe width) instead of height as we have static content length once expanded
            // opposed to width of the screen which changes in fullscreen/inline mode
            const viewportWidth = window.innerWidth;

            const shouldBeExpanded = viewportWidth > FULLSCREEN_WIDTH_THRESHOLD;

            // If user manually collapsed, don't auto-expand until width actually drops below threshold
            // Override for mobile version when detection doesn't work
            // Override for non open ai mode, when there's no fullscreen handler (debugging purposes)'
            if (manuallyCollapsed.current && shouldBeExpanded) {
                return;
            }

            // If user manually expanded, don't auto-collapse until width actually exceeds threshold
            // Override for non open ai mode, when there's no fullscreen handler (debugging purposes)
            if (manuallyExpanded.current && !shouldBeExpanded) {
                return;
            }

            if (shouldBeExpanded) {
                manuallyExpanded.current = false;
            }

            if (!shouldBeExpanded) {
                manuallyCollapsed.current = false;
            }

            setIsExpanded(shouldBeExpanded);
        });

        resizeObserver.observe(document.body);

        return () => {
            resizeObserver.disconnect();
        };
    }, [setIsExpanded, manuallyCollapsed, manuallyExpanded]);

    if (!readme) return null;

    return (
        <SectionContent ref={sectionRef} p="space16" $isExpanded={isExpanded}>
            <ReadmeWrapper>
                <ReadmeHeader>
                    <BadgeWrapper>
                        <Badge
                            size="small"
                            LeadingIcon={BookOpenIcon}
                        >
                            Readme
                        </Badge>
                    </BadgeWrapper>
                </ReadmeHeader>
                <div className={README_CLASSNAMES.MARKDOWN_WRAPPER}>
                    <Markdown
                        markdown={readme}
                        className={README_CLASSNAMES.MARKDOWN}
                        allowElement={allowElement}
                        lazyLoadImages
                    />
                </div>
            </ReadmeWrapper>
            {!isExpanded && <GradientOverlay />}
        </SectionContent>
    );
};

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const manuallyCollapsed = useRef(false);
    const manuallyExpanded = useRef(false);
    const actor = details.actorInfo;

    const handleToggleExpand = async () => {
        if (!isExpanded) {
            manuallyExpanded.current = true;
            manuallyCollapsed.current = false;
            setIsExpanded(true);
            await window.openai?.requestDisplayMode({ mode: "fullscreen" });
        } else {
            manuallyCollapsed.current = true;
            manuallyExpanded.current = false;
            setIsExpanded(false);
            await window.openai?.requestDisplayMode({ mode: "inline" });
        }
    };

    const fullscreenButton = (
        <IconButton
            Icon={isExpanded ? MinimizeIcon : FullscreenIcon}
            variant={ICON_BUTTON_VARIANTS.BORDERED}
            onClick={handleToggleExpand}
        />
    );

    return (
        <Container>
            <CardWrapper>
                <ActorCard actor={actor} isDetail customActionButton={fullscreenButton} />
                <ReadmeSection
                    readme={details.readme}
                    isExpanded={isExpanded}
                    setIsExpanded={setIsExpanded}
                    manuallyCollapsed={manuallyCollapsed}
                    manuallyExpanded={manuallyExpanded}
                />
            </CardWrapper>
        </Container>
    );
};
