import { ActorSearchDetail } from "../pages/ActorSearch/ActorSearchDetail";
import { renderWidget } from "../utils/init-widget";
import { useWidgetProps } from "../hooks/use-widget-props";
import type { ActorDetails } from "../types";

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

(async () => {
    if (IS_DEV_BUILD) {
        const { setupActorDetailWidgetDev } = await import("./actor-detail-widget.dev");
        setupActorDetailWidgetDev();
    }
    renderWidget(ActorDetailWrapper);
})();
