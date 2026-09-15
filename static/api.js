export async function readResponse(response) {
  let result;
  try { result = await response.json(); }
  catch {
    if (response.status === 403) throw new Error('The server or its security gateway blocked this request (HTTP 403). Reload the page and try again.');
    if (response.status === 429) throw new Error('Too many requests. Please wait a few minutes before trying again.');
    if (response.status >= 500) throw new Error(`The server or its gateway is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`);
    throw new Error(`The server returned an unexpected response (HTTP ${response.status}). Reload the page and try again.`);
  }
  if (!response.ok || !result?.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'The request failed. Please try again.');
  return result;
}
