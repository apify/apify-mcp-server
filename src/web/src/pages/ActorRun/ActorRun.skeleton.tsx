import React from "react";
import styled from "styled-components";
import { SkeletonBlock } from "../../components/ui/SkeletonBlock";
import { theme } from "@apify/ui-library";

const TableContainer = styled.div`
    width: 100%;
    overflow-x: auto;
    overflow-y: auto;
    border: 1px solid ${theme.color.neutral.separatorSubtle};
    border-radius: ${theme.radius.radius12};
    background: ${theme.color.neutral.background};
    position: relative;
    max-height: 265px;
`;

const Table = styled.table`
    width: 100%;
    border-collapse: collapse;
`;

const TableHeader = styled.thead`
    background: ${theme.color.neutral.backgroundMuted};
    position: sticky;
    top: 0;
    z-index: 1;
`;

const TableHeaderCell = styled.th`
    text-align: left;
    padding: ${theme.space.space8} ${theme.space.space16};
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};
    border-bottom: 1px solid ${theme.color.neutral.separatorSubtle};

    &:last-child {
        border-right: none;
    }
`;

const TableBody = styled.tbody``;

const TableRow = styled.tr`
    border-bottom: 1px solid ${theme.color.neutral.separatorSubtle};

    &:last-child {
        border-bottom: none;
    }
`;

const TableCell = styled.td`
    padding: ${theme.space.space10} ${theme.space.space16};
    border-right: 1px solid ${theme.color.neutral.separatorSubtle};
    background: ${theme.color.neutral.background};

    &:last-child {
        border-right: none;
    }
`;

export const TableSkeleton: React.FC = () => {
    return (
        <TableContainer>
                <Table>
                    <TableHeader>
                        <tr>
                            {[0, 1, 2, 3, 4].map((i) => (
                                <TableHeaderCell key={i}>
                                    <SkeletonBlock style={{ width: `${60 + (i * 10)}px`, height: '12px' }} />
                                </TableHeaderCell>
                            ))}
                        </tr>
                    </TableHeader>
                    <TableBody>
                        {[0, 1, 2, 3, 4].map((rowIndex) => (
                            <TableRow key={rowIndex}>
                                {[0, 1, 2, 3, 4].map((colIndex) => (
                                    <TableCell key={colIndex}>
                                        <SkeletonBlock
                                            style={{
                                                width: `${70 + ((rowIndex + colIndex) % 3) * 30}px`,
                                                height: '14px'
                                            }}
                                        />
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
    );
};
