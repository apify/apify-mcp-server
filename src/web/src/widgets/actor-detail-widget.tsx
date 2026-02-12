import { ActorSearchDetail } from "../pages/ActorSearch/ActorSearchDetail";
import { setupMockOpenAi } from "../utils/mock-openai";
import { MOCK_ACTOR_DETAILS_RESPONSE } from "../utils/mock-actor-details";
import { renderWidget } from "../utils/init-widget";

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

// Create a wrapper component that extracts details from toolOutput
const ActorDetailWrapper = () => {
    const details = (window.openai?.toolOutput as any)?.details;

    if (!details) {
        return <div>No actor details available</div>;
    }

    return <ActorSearchDetail details={details} />;
};

renderWidget(ActorDetailWrapper);
