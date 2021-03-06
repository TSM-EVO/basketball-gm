// @flow

const fetchWrapper = async ({
    url,
    method,
    headers,
    data,
    credentials,
}: {
    url: string,
    method: 'GET' | 'POST',
    headers?: {[key: string]: string},
    data: Object,
    credentials?: 'include',
}): any => {
    let body;
    if ((typeof FormData !== 'undefined' && data instanceof FormData) || (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams)) {
        body = data;
    } else if (data !== undefined) {
        body = new URLSearchParams();
        for (const key of Object.keys(data)) {
            body.set(key, data[key]);
        }
    }

    // For GET request, append data to query string, since fetch doesn't like GET and body
    if (method === 'GET' && body !== undefined) {
        url += `?${body.toString()}`;
        body = undefined;
    }

    if (headers !== undefined) {
        headers = new Headers(headers);
    }

    const response = await fetch(url, {
        method,
        headers,
        body,
        credentials,
    });

    // HACK HACK HACK! Some of my APIs (logout) return no content, rather than JSON
    if (url.includes('logout.php')) {
        return undefined;
    }
    return response.json();
};

export default fetchWrapper;
