import "../index.css";
import React from "react";
import { createRoot } from "react-dom/client";

function resolveTheme(): "light" | "dark" {
    const t = window.openai?.theme;
    if (t === "dark") return "dark";
    if (t === "light") return "light";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark") {
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
}

export const renderWidget = (Component: React.FC) => {
    const initWidget = () => {
        const rootElement = document.getElementById("root");
        if (!rootElement) return;

        applyTheme(resolveTheme());

        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onSystemThemeChange = (e: MediaQueryListEvent) => {
            const t = window.openai?.theme;
            if (t !== "dark" && t !== "light") {
                applyTheme(e.matches ? "dark" : "light");
            }
        };
        mq.addEventListener("change", onSystemThemeChange);

        let lastTheme = resolveTheme();
        const checkTheme = () => {
            const current = resolveTheme();
            if (current !== lastTheme) {
                lastTheme = current;
                applyTheme(current);
            }
        };

        window.setInterval(checkTheme, 1000);

        const root = createRoot(rootElement);
        root.render(
            <React.StrictMode>
                <Component />
            </React.StrictMode>
        );
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initWidget, { once: true });
    } else {
        initWidget();
    }
};
