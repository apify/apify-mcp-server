import { ActorSearchDetail } from "../pages/ActorSearch/ActorSearchDetail";
import { setupMockOpenAi } from "../utils/mock-openai";
import { MOCK_ACTOR_DETAILS_RESPONSE } from "../utils/mock-actor-details";
import { renderWidget } from "../utils/init-widget";
import { useWidgetProps } from "../hooks/use-widget-props";
import type { ActorDetails } from "../types";

const shouldEnableMocks = typeof window !== "undefined" && !(window as any).openai;

if (shouldEnableMocks) {
    // Set up mock window.openai for local development
    setupMockOpenAi({
        toolOutput: {
            details: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent.actorDetails,
        },
        initialWidgetState: {},
    });
}

interface WidgetToolOutput extends Record<string, unknown> {
    details?: ActorDetails;
}

const ActorDetailWrapper = () => {
    const toolOutput = useWidgetProps<WidgetToolOutput>();
    const details = toolOutput?.details;

    if (!details) {
        return <div>No actor details available</div>;
    }

    return <ActorSearchDetail details={details} />;
};

renderWidget(ActorDetailWrapper);
