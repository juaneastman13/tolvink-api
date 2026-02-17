declare module 'web-push' {
  interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  interface WebPushResult {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(
    subscription: PushSubscription,
    payload: string | Buffer,
    options?: any,
  ): Promise<WebPushResult>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
}
