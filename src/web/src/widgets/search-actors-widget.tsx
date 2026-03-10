import { ActorSearch } from "../pages/ActorSearch/ActorSearch";
import { renderWidget } from "../utils/init-widget";

(async () => {
    if (IS_DEV_BUILD) {
        const { setupSearchActorsWidgetDev } = await import("./search-actors-widget.dev");
        setupSearchActorsWidgetDev();
    }
    renderWidget(ActorSearch);
})();
