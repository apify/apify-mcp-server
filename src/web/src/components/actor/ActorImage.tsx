import React from "react";
import { Cube } from "../ui/Icons";

interface ActorImageProps {
  name: string;
  size: number;
  pictureUrl?: string;
}

export const ActorImage: React.FC<ActorImageProps> = ({ pictureUrl, name, size = 40 }) => {
    return (
        <div
            className="shrink-0 overflow-hidden rounded-lg"
            style={{ width: `${size}px`, height: `${size}px`, maxWidth: `${size}px` }}
        >
            {pictureUrl ? (
                <img src={pictureUrl} alt={name} className="w-full h-full object-cover rounded-lg" />
            ) : (
                <div
                    className="w-full h-full flex items-center justify-center rounded-lg bg-[linear-gradient(135deg,_#FF9013_0%,_#FF6B00_100%)]"
                >
                    <Cube className="w-[40%] h-[40%] text-white" />
                </div>
            )}
        </div>
    );
};
