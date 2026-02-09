import type { User } from 'apify-client';

import { ApifyClient } from '../apify-client.js';

/**
 * Fetches public data about a specific user.
 *
 * @param userId - The ID or username of the user
 * @param apifyToken - Apify API token for authentication
 * @returns User data
 */
export async function fetchUserData(userId: string, apifyToken: string): Promise<User> {
    const client = new ApifyClient({ token: apifyToken });
    const userData = await client.user(userId).get();
    return userData;
}
