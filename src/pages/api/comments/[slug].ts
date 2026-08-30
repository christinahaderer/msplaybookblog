import type { APIRoute } from 'astro';

export const prerender = false;

interface Comment {
	id: string;
	name: string;
	message: string;
	date: string;
}

const MAX_NAME_LENGTH = 60;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_COMMENTS_STORED = 300;
const RATE_LIMIT_SECONDS = 60; // Cloudflare KV's minimum expirationTtl is 60s

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

export const GET: APIRoute = async ({ params, locals }) => {
	const slug = params.slug;
	if (!slug) return jsonResponse({ error: 'Missing slug.' }, 400);

	const kv = locals.runtime.env.COMMENTS;
	const raw = await kv.get(`comments:${slug}`);
	const comments: Comment[] = raw ? JSON.parse(raw) : [];
	return jsonResponse({ comments });
};

export const POST: APIRoute = async ({ params, request, locals, clientAddress }) => {
	const slug = params.slug;
	if (!slug) return jsonResponse({ error: 'Missing slug.' }, 400);

	const kv = locals.runtime.env.COMMENTS;

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: 'Invalid request.' }, 400);
	}

	// Honeypot: real visitors never see or fill this field. Pretend success
	// so bots don't learn to leave it blank.
	if (typeof body.website === 'string' && body.website.trim() !== '') {
		return jsonResponse({ ok: true }, 201);
	}

	const name = typeof body.name === 'string' ? body.name.trim() : '';
	const message = typeof body.message === 'string' ? body.message.trim() : '';

	if (!name || !message) {
		return jsonResponse({ error: 'Name and comment are required.' }, 400);
	}
	if (name.length > MAX_NAME_LENGTH) {
		return jsonResponse({ error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` }, 400);
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		return jsonResponse(
			{ error: `Comment must be ${MAX_MESSAGE_LENGTH} characters or fewer.` },
			400,
		);
	}

	// Light per-visitor rate limit so a script can't flood the thread.
	const ip = clientAddress || request.headers.get('cf-connecting-ip') || 'local';
	const rateLimitKey = `ratelimit:${slug}:${ip}`;
	const recentlyPosted = await kv.get(rateLimitKey);
	if (recentlyPosted) {
		return jsonResponse({ error: 'Please wait a moment before posting again.' }, 429);
	}

	const key = `comments:${slug}`;
	const raw = await kv.get(key);
	const comments: Comment[] = raw ? JSON.parse(raw) : [];

	comments.push({
		id: crypto.randomUUID(),
		name,
		message,
		date: new Date().toISOString(),
	});

	while (comments.length > MAX_COMMENTS_STORED) {
		comments.shift();
	}

	await kv.put(key, JSON.stringify(comments));
	await kv.put(rateLimitKey, '1', { expirationTtl: RATE_LIMIT_SECONDS });

	return jsonResponse({ comments }, 201);
};
