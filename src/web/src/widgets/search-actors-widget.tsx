import { ActorSearch } from '../pages/ActorSearch/ActorSearch';
import { renderWidget } from '../utils/init-widget';

(async () => {
    if (IS_DEV_BUILD) {
        const { setupSearchActorsWidgetDev } = await import('./search-actors-widget.dev');
        setupSearchActorsWidgetDev();
    }
    // ext-apps#696 workaround: both tools rendering this widget are read-only, so a
    // Desktop-stripped result can be recovered by re-calling the tool through the host proxy.
    renderWidget(ActorSearch, {
        refetchToolForArgs: (args) => ('actor' in args ? 'fetch-actor-details-widget' : 'search-actors-widget'),
    });
})();
