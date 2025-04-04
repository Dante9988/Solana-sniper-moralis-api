import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Retry configuration for API calls
 */
interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

/**
 * Default retry configuration
 */
const defaultRetryConfig: RetryConfig = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 15000,
  backoffFactor: 2
};

/**
 * Sleep for a specified number of milliseconds
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Make an API request with exponential backoff retry for rate limit errors
 */
export async function fetchWithRetry<T>(
  url: string,
  options: AxiosRequestConfig = {},
  retryConfig: RetryConfig = defaultRetryConfig
): Promise<T> {
  let lastError: Error | null = null;
  let delayMs = retryConfig.initialDelayMs;
  
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      // Add a random delay between 100-500ms to avoid hitting rate limits
      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * 400) + 100;
        await sleep(delayMs + jitter);
        console.log(`Retry attempt ${attempt}/${retryConfig.maxRetries} for ${url}`);
      }
      
      const response: AxiosResponse = await axios({
        url,
        ...options,
        headers: {
          ...options.headers,
          'User-Agent': 'Strobe-AI/1.0',
        }
      });
      
      return response.data as T;
    } catch (error) {
      lastError = error as Error;
      
      // Check if it's a rate limit error (429)
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.warn(`Rate limit exceeded (429) for ${url}. Retrying in ${delayMs}ms...`);
        
        // Get retry-after header if available
        const retryAfter = error.response.headers['retry-after'];
        if (retryAfter && !isNaN(Number(retryAfter))) {
          delayMs = Number(retryAfter) * 1000;
        } else {
          // Exponential backoff with max delay cap
          delayMs = Math.min(delayMs * retryConfig.backoffFactor, retryConfig.maxDelayMs);
        }
        
        // If this was the last attempt, throw the error
        if (attempt === retryConfig.maxRetries) {
          throw new Error(`Maximum retry attempts (${retryConfig.maxRetries}) reached for ${url}: ${error.message}`);
        }
        
        // Otherwise continue to next retry attempt
        continue;
      }
      
      // For other errors, throw immediately
      throw error;
    }
  }
  
  // This should never be reached due to the throw in the loop
  throw lastError || new Error(`Unknown error occurred while fetching ${url}`);
}

/**
 * Make a Birdeye API request with retry logic
 */
export async function fetchBirdeyeWithRetry<T>(
  endpoint: string,
  options: AxiosRequestConfig = {}
): Promise<T> {
  const url = `https://public-api.birdeye.so/${endpoint}`;
  const config: AxiosRequestConfig = {
    ...options,
    headers: {
      ...options.headers,
      'X-API-KEY': process.env.BIRDEYE_API_KEY || '',
      'Accept': 'application/json',
    }
  };
  
  // Use a more aggressive retry strategy for Birdeye
  const birdeyeRetryConfig: RetryConfig = {
    maxRetries: 7,
    initialDelayMs: 2000,
    maxDelayMs: 30000,
    backoffFactor: 2.5
  };
  
  return fetchWithRetry<T>(url, config, birdeyeRetryConfig);
} 
