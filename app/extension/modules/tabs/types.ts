export type SwitchTabResult =
    | { error: string; hint: string }
    | {
          success: true;
          message: string;
          url?: string;
          title?: string;
          newActiveTabId: number;
      };
