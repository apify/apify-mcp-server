import React from "react";
import styled from "styled-components";
import { Box, Markdown, theme, useActorTitleHeadingFilter } from "@apify/ui-library";
import { ActorDetails } from "../../types";
import { ActorCard } from "../../components/actor/ActorCard";

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
`;

const CardWrapper = styled(Box)`
    background: ${theme.color.neutral.background};
    border-radius: ${theme.radius.radius8};
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    display: flex;
    flex-direction: column;
    overflow: hidden;
    width: 100%;
`;

const SectionContent = styled(Box)`
    background: ${theme.color.neutral.background};
    border-top: 1px solid ${theme.color.neutral.separatorSubtle};
    overflow: hidden;
    color: ${theme.color.neutral.text};
`;

const ReadmeWrapper = styled.div`
    display: grid;
    grid-template-columns: 85% 15%;
    grid-template-rows: auto;
    grid-template-areas: 'readme readme';

    .${README_CLASSNAMES.MARKDOWN_WRAPPER} {
        grid-area: readme;
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

type ReadmeSectionProps = {
    readme: string | null;
}

const ReadmeSection: React.FC<ReadmeSectionProps> = ({ readme }) => {
    if (!readme) return null

    const allowElement = useActorTitleHeadingFilter("Readme");

    return (
        <SectionContent p="space16">
            <ReadmeWrapper>
                <div className={README_CLASSNAMES.MARKDOWN_WRAPPER}>
                    <Markdown markdown={readme} className={README_CLASSNAMES.MARKDOWN} allowElement={allowElement} lazyLoadImages/>
                </div>
            </ReadmeWrapper>
        </SectionContent>
    );
};

export const ActorSearchDetail: React.FC<ActorSearchDetailProps> = ({ details }) => {
    const actor = details.actorInfo;

    return (
        <Container>
            <CardWrapper>
                <ActorCard actor={actor} isDetail />
                 <ReadmeSection readme={details.readme} />
            </CardWrapper>
        </Container>
    );
};
