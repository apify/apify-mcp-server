import { ActorSearchDetail } from "../pages/ActorSearch/ActorSearchDetail";
import { setupMockOpenAi } from "../utils/mock-openai";
import { MOCK_ACTOR_DETAILS_RESPONSE } from "../utils/mock-actor-details";
import { renderWidget } from "../utils/init-widget";
import type { ActorDetails } from "../types";

const shouldEnableMocks = typeof window !== "undefined" && !window.openai;

if (shouldEnableMocks) {
    // Set up mock window.openai for local development
    setupMockOpenAi({
        toolOutput: {
            details: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent.actorDetails,
        },
        initialWidgetState: {},
    });
}

interface OpenAIToolOutput {
    details?: ActorDetails;
}

const ActorDetailWrapper = () => {
    const details = (window.openai?.toolOutput as OpenAIToolOutput)?.details;

    if (!details) {
        return <div>No actor details available</div>;
    }

    return <ActorSearchDetail details={details} />;
};

renderWidget(ActorDetailWrapper);
