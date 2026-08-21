export interface BlockedRequest {
    requestId: string;
    method: string;
    url: string;
    postData?: string;
    timestamp: number;
    // "recorded": replayed a real response this exact method+URL produced
    // earlier this session. "echo": no prior real response was found, so the
    // mock just mirrors the submitted body back.
    mockSource: "recorded" | "echo";
}
