import type { MockRequester } from './mock-requester.js';

const STORAGE_KEY = Symbol('__whop_mock_original_requester');
const REQUESTER_KEY = '_requester';

type SDKClient = {
  [key: string]: unknown;
  [STORAGE_KEY]?: unknown;
};

/**
 * Patches SDK client to use mock requester.
 * Works by swapping the internal _requester property.
 */
export class ClientPatcher {
  private client: SDKClient;
  private mockRequester: MockRequester;

  constructor(client: unknown, mockRequester: MockRequester) {
    this.client = client as SDKClient;
    this.mockRequester = mockRequester;
  }

  install(): void {
    // Store original requester
    if (!(REQUESTER_KEY in this.client)) {
      throw new Error(
        `Client does not expose ${REQUESTER_KEY} for mock installation. ` +
        `Make sure you're using a compatible version of @whop/sdk.`
      );
    }

    // Save original
    this.client[STORAGE_KEY] = this.client[REQUESTER_KEY];

    // Install mock
    this.client[REQUESTER_KEY] = this.mockRequester;
  }

  uninstall(): void {
    const original = this.client[STORAGE_KEY];
    if (!original) return;

    this.client[REQUESTER_KEY] = original;
    delete this.client[STORAGE_KEY];
  }
}
