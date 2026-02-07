import React from "react";
import styled from "styled-components";
import { Heading, Text, theme } from "@apify/ui-library";
import { WidgetLayout } from "../../components/layout/WidgetLayout";

const Container = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space24};
    width: 100%;
    max-width: 600px;
    margin: 0 auto;
`;

const NavList = styled.ul`
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: ${theme.space.space12};
`;

const NavItem = styled.li`
    margin: 0;
`;

const NavLink = styled.a`
    color: ${theme.color.primary.action};
    text-decoration: none;
    font-weight: 500;
    display: block;
    padding: ${theme.space.space12} ${theme.space.space16};
    background: ${theme.color.neutral.background};
    border: 1px solid ${theme.color.neutral.textSubtle};
    border-radius: ${theme.radius.radius8};
    transition: all 0.2s ease;

    &:hover {
        background: ${theme.color.neutral.backgroundSubtle};
        border-color: ${theme.color.primary.action};
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }
`;

export const Landing: React.FC = () => {
    const handleNavigation = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
        e.preventDefault();
        window.location.href = href;
    };

    return (
        <WidgetLayout>
            <Container>
                <Heading type="titleL" mb="space8">
                    Apify Widgets
                </Heading>

                <Text type="body" size="regular" mb="space16">
                    Test pages for individual widgets (isolated environments):
                </Text>

                <NavList>
                    <NavItem>
                        <NavLink
                            href="/index-actor-run-new.html"
                            onClick={(e) => handleNavigation(e, "/index-actor-run-new.html")}
                        >
                            Actor Run Widget (New Design)
                        </NavLink>
                    </NavItem>
                    <NavItem>
                        <NavLink
                            href="/index-actor-search.html"
                            onClick={(e) => handleNavigation(e, "/index-actor-search.html")}
                        >
                            Actor Search Widget
                        </NavLink>
                    </NavItem>
                    <NavItem>
                        <NavLink
                            href="/index-actor-run.html"
                            onClick={(e) => handleNavigation(e, "/index-actor-run.html")}
                        >
                            Actor Run Widget (Original)
                        </NavLink>
                    </NavItem>
                </NavList>
            </Container>
        </WidgetLayout>
    );
};
