import React from "react";

interface IconProps {
    className?: string;
    size?: number;
}

export const ArrowLeft: React.FC<IconProps> = ({ className = "" }) => (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path fillRule="evenodd" d="M5.293 12.707a1 1 0 0 1 0-1.414l5-5a1 1 0 1 1 1.414 1.414L8.414 11H18a1 1 0 1 1 0 2H8.414l3.293 3.293a1 1 0 0 1-1.414 1.414l-5-5Z" clipRule="evenodd" />
    </svg>
);

export const Cube: React.FC<IconProps> = ({ className = "" }) => (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path fillRule="evenodd" d="M12.5 3.444a1 1 0 0 0-1 0l-6.253 3.61 6.768 3.807 6.955-3.682-6.47-3.735Zm7.16 5.632L13 12.602v7.666l6.16-3.556a1 1 0 0 0 .5-.867V9.076ZM11 20.268v-7.683L4.34 8.839v7.006a1 1 0 0 0 .5.867L11 20.268Zm-.5-18.557a3 3 0 0 1 3 0l6.66 3.846a3 3 0 0 1 1.5 2.598v7.69a3 3 0 0 1-1.5 2.598L13.5 22.29a3 3 0 0 1-3 0l-6.66-3.846a3 3 0 0 1-1.5-2.598v-7.69a3 3 0 0 1 1.5-2.598L10.5 1.71Z" clipRule="evenodd" />
    </svg>
);

export const MembersFilled: React.FC<IconProps> = ({ className = "" }) => (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M2.22222 20C1.54721 20 1 19.4563 1 18.7857C1 16.7307 1.99227 15.1645 3.42364 14.1533C4.81866 13.1677 6.60907 12.7143 8.33333 12.7143C10.0576 12.7143 11.848 13.1677 13.243 14.1533C14.6744 15.1645 15.6667 16.7307 15.6667 18.7857C15.6667 19.4563 15.1195 20 14.4444 20C12.7348 20 3.93184 20 2.22222 20Z" fill="currentColor" />
        <path d="M17.5 18.7857C17.5 16.4257 16.487 14.5332 14.998 13.2166C15.7888 12.8756 16.655 12.7143 17.5 12.7143C18.7932 12.7143 20.136 13.0921 21.1823 13.9134C22.2558 14.7561 23 16.0613 23 17.7738C23 18.3327 22.5896 18.7857 22.0833 18.7857H17.5Z" fill="currentColor" />
        <path d="M8.33333 3C5.97078 3 4.05556 4.90279 4.05556 7.25C4.05556 9.59721 5.97078 11.5 8.33333 11.5C10.6959 11.5 12.6111 9.59721 12.6111 7.25C12.6111 4.90279 10.6959 3 8.33333 3Z" fill="currentColor" />
        <path d="M17.5 5.42857C15.8125 5.42857 14.4444 6.78771 14.4444 8.46429C14.4444 10.1409 15.8125 11.5 17.5 11.5C19.1875 11.5 20.5556 10.1409 20.5556 8.46429C20.5556 6.78771 19.1875 5.42857 17.5 5.42857Z" fill="currentColor" />
    </svg>
);

export const Play: React.FC<IconProps> = ({ className = "" }) => (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M9.5 9.33165V14.6683C9.5 15.4595 10.3752 15.9373 11.0408 15.5095L15.1915 12.8412C15.8038 12.4475 15.8038 11.5524 15.1915 11.1588L11.0408 8.49047C10.3752 8.06265 9.5 8.54049 9.5 9.33165Z" fill="currentColor" />
        <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12Z" fill="currentColor" />
    </svg>
);

export const Check: React.FC<IconProps> = ({ className = "" }) => (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path fillRule="evenodd" d="M19.916 4.626a1 1 0 0 1 .208 1.4l-9 13.5a1 1 0 0 1-1.614.116l-6-6a1 1 0 1 1 1.414-1.414l5.226 5.226 8.45-12.675a1 1 0 0 1 1.316-.408Z" clipRule="evenodd" />
    </svg>
);

