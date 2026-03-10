import { MOCK_ACTOR_DETAILS_RESPONSE } from "../utils/mock-actor-details";
import { setupMockOpenAi } from "../utils/mock-openai";

export function setupActorDetailWidgetDev(): void {
    if (typeof window === "undefined" || window.openai) {
        return;
    }

    setupMockOpenAi({
        toolOutput: {
            details: MOCK_ACTOR_DETAILS_RESPONSE.structuredContent.actorDetails,
        },
        initialWidgetState: {},
    });
}
