export interface PeekScreenResult {
    tabId: number;
    url: string;
    title: string;
    isWorkspaceTab: boolean;
    permissions: "control" | "read_only";
    selectedText?: string;
    h1?: string;
    text: string;
    textLength: number;
    screenshotBase64?: string;
    _flowWarning?: string;
    [key: string]: unknown;
}
