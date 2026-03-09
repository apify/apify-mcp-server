import { ActorRun } from "../pages/ActorRun/ActorRun";
import { renderWidget } from "../utils/init-widget";

(async () => {
    if (IS_DEV_BUILD) {
        const { setupActorRunWidgetDev } = await import("./actor-run-widget.dev");
        setupActorRunWidgetDev();
    }
    renderWidget(ActorRun);
})();
