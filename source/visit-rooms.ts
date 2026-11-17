#!/usr/bin/env node

import { chromium, type Response } from "playwright";
import { JSONFilePreset } from "lowdb/node";
import { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const program = new Command();
program
	.name("roomie")
	.description("Scan .explore-card elements, open unvisited rooms one at a time, download .zip")
	.option("--tab <name>", "Optional tab name / label (currently only logged)")
	.parse(process.argv);

const opts = program.opts();

if (!BASE_URL) {
	console.error("ERROR: BASE_URL environment variable is required.");
	console.error('Example (PowerShell):  $env:BASE_URL = "https://example.com/explore"');
	process.exit(1);
}

const delay = (ms = DELAY_MS) => new Promise((r) => setTimeout(r, ms));

const db = await JSONFilePreset<RoomsT>(DB_PATH, {});

async function main() {
	console.log("roomie starting…");
	if (opts.tab) console.log(`--tab: ${opts.tab}`);
	console.log(`Start URL     : ${BASE_URL}`);
	console.log(`Download dir  : ${DOWNLOAD_PATH}`);
	console.log(`Visited DB    : ${DB_PATH}`);
	console.log(`Delay         : ${DELAY_MS} ms`);
	console.log(`Headless      : ${IS_HEADLESS}`);
	console.log("");

	await fs.mkdir(DOWNLOAD_PATH, { recursive: true });

	const browser = await chromium.launch({
		headless: IS_HEADLESS,
		downloadsPath: DOWNLOAD_PATH,
	});

	const context = await browser.newContext({
		acceptDownloads: true,
	});

	const listPage = await context.newPage();

	console.log("Navigating to start URL…");
	await listPage.goto(BASE_URL, { waitUntil: "domcontentloaded" });
	await delay();

	// ⚠️  CUSTOMIZE this block to match the real structure of your .explore-card elements
	const rooms = await listPage.evaluate(() => {
		const result: Record<string, string> = {};
		const cards = document.querySelectorAll(".explore-card");

		cards.forEach((card, index) => {
			const link =
				card.querySelector("a[href]") ||
				card.closest("a[href]") ||
				card;

			const href =
				(link instanceof HTMLAnchorElement && link.href) ||
				card.getAttribute("data-url") ||
				card.getAttribute("href") ||
				null;

			if (!href) return;

			const id =
				card.getAttribute("data-id") ||
				card.getAttribute("data-room-id") ||
				card.id ||
				href.split("/").filter(Boolean).pop() ||
				`card-${index}`;

			result[id] = href;
		});

		return result;
	});

	const entries = Object.entries(rooms);
	console.log(`Found ${entries.length} .explore-card item(s).`);
	await delay();

	for (const [id, url] of entries) {
		if (db.data[id]) {
			console.log(`SKIP  already visited → ${id}`);
			continue;
		}

		console.log(`\n→ Processing ${id}`);
		console.log(`  URL: ${url}`);
		await delay();

		const roomPage = await context.newPage();

		// Wait for the first successful response whose URL contains ".zip"
		const zipResponsePromise = roomPage.waitForResponse(
			(resp: Response) => {
				const u = resp.url().toLowerCase();
				return u.includes(".zip") && resp.ok();
			},
			{ timeout: 60_000 }
		);

		try {
			await roomPage.goto(url, { waitUntil: "domcontentloaded" });
			await delay();

			console.log("  Waiting for .zip response…");
			const zipResponse = await zipResponsePromise;
			const zipUrl = zipResponse.url();
			console.log(`  Found .zip → ${zipUrl}`);
			await delay();

			const buffer = await zipResponse.body();
			const filename = path.basename(new URL(zipUrl).pathname) || `${id}.zip`;
			const dest = path.join(DOWNLOAD_PATH, filename);

			await fs.writeFile(dest, buffer);
			console.log(`  Saved → ${dest}`);
			await delay();

			db.data[id] = url;
			await db.write();
			console.log(`  Recorded in previously-visited.json`);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`  FAILED for ${id}:`, message);
			// Do not mark as visited so it can be retried next run
		} finally {
			await delay();
			await roomPage.close();
			await delay();
		}
	}

	console.log("\nDone.");
	await browser.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});