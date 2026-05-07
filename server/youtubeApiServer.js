import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const PORT = Number(process.env.PORT || 8787);
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();
const execFileAsync = promisify(execFile);

loadEnv();

const API_KEY = process.env.YOUTUBE_API_KEY;
const REGION_CODE = process.env.YOUTUBE_REGION_CODE || "US";
const RELEVANCE_LANGUAGE = process.env.YOUTUBE_RELEVANCE_LANGUAGE || "en";

const DEFAULT_TOPICS = [
  { label: "AI 视觉", query: "AI generated animation youtube" },
  { label: "修复手工", query: "restoration project" },
  { label: "街头食物", query: "street food shorts" },
  { label: "历史科普", query: "history documentary explained" },
  { label: "微缩建造", query: "tiny build miniature" },
  { label: "3D 动画", query: "3D animation shorts" },
];

const GLOBAL_TREND_TOPICS = [
  { label: "全站热门 Shorts", query: "shorts" },
  { label: "全站热门音乐", query: "music video" },
  { label: "全站热门预告", query: "official trailer" },
  { label: "全站热门游戏", query: "gaming" },
  { label: "全站热门集锦", query: "highlights" },
  { label: "全站热门娱乐", query: "viral video" },
  { label: "全站热门体育", query: "sports highlights" },
  { label: "全站热门电影", query: "movie trailer" },
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, { ok: true, hasKey: Boolean(API_KEY), cachedKeys: cache.size });
      return;
    }

    if (url.pathname === "/api/opportunities") {
      if (!API_KEY) {
        sendJson(res, { ok: false, error: "Missing YOUTUBE_API_KEY" }, 500);
        return;
      }

      const refresh = url.searchParams.get("refresh") === "1";
      const range = normalizeRange(url.searchParams.get("range"));
      const payload = await getOpportunities(refresh, range);
      sendJson(res, { ok: true, ...payload });
      return;
    }

    sendJson(res, { ok: false, error: "Not found" }, 404);
  } catch (error) {
    console.error(error);
    sendJson(res, { ok: false, error: error.message || "Unknown server error" }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`YouTube API server listening on http://127.0.0.1:${PORT}`);
});

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

async function getOpportunities(refresh = false, range = "7d") {
  const cacheKey = `opportunities:${range}`;
  const cached = cache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return { ...cached.value, cache: "hit" };
  }

  const windowHours = rangeToHours(range);
  const publishedAfter = new Date(Date.now() - 1000 * 60 * 60 * windowHours).toISOString();
  const searches = await Promise.all(
    [...GLOBAL_TREND_TOPICS, ...DEFAULT_TOPICS].map(async (topic) => {
      const result = await youtube("search", {
        part: "snippet",
        type: "video",
        maxResults: "10",
        order: "viewCount",
        q: topic.query,
        publishedAfter,
        regionCode: REGION_CODE,
        relevanceLanguage: RELEVANCE_LANGUAGE,
      });
      return (result.items || []).map((item) => ({
        videoId: item.id?.videoId,
        topic: topic.label,
      }));
    }),
  );

  const videoTopicMap = new Map();
  const popular = await youtube("videos", {
    part: "snippet,statistics,contentDetails",
    chart: "mostPopular",
    maxResults: "50",
    regionCode: REGION_CODE,
  });

  for (const item of popular.items || []) {
    const publishedAt = item.snippet?.publishedAt ? new Date(item.snippet.publishedAt).getTime() : 0;
    if (publishedAt && publishedAt >= Date.now() - 1000 * 60 * 60 * windowHours) {
      videoTopicMap.set(item.id, "全站热门");
    }
  }

  for (const item of searches.flat()) {
    if (item.videoId && !videoTopicMap.has(item.videoId)) {
      videoTopicMap.set(item.videoId, item.topic);
    }
  }

  const videoIds = [...videoTopicMap.keys()].slice(0, 50);
  if (videoIds.length === 0) {
    const empty = { videos: [], channels: [], updatedAt: new Date().toISOString() };
    cache.set(cacheKey, { createdAt: Date.now(), value: empty });
    return { ...empty, cache: "miss" };
  }

  const videosResponse = videoIds.length
    ? await youtube("videos", {
        part: "snippet,statistics,contentDetails",
        id: videoIds.join(","),
        maxResults: "50",
      })
    : { items: [] };

  const rawVideos = mergeById([...(popular.items || []), ...(videosResponse.items || [])]).filter((video) => {
    const publishedAt = video.snippet?.publishedAt ? new Date(video.snippet.publishedAt).getTime() : 0;
    return publishedAt && publishedAt >= Date.now() - 1000 * 60 * 60 * windowHours;
  });
  const channelIds = [...new Set(rawVideos.map((video) => video.snippet?.channelId).filter(Boolean))];
  const channelResponse = await youtube("channels", {
    part: "snippet,statistics",
    id: channelIds.join(","),
    maxResults: "50",
  });

  const channels = new Map();
  for (const channel of channelResponse.items || []) {
    channels.set(channel.id, {
      id: channel.id,
      name: channel.snippet?.title || "Unknown Channel",
      avatar: channel.snippet?.thumbnails?.default?.url || channel.snippet?.thumbnails?.medium?.url || "",
      subscribers: numberFrom(channel.statistics?.subscriberCount),
      views: numberFrom(channel.statistics?.viewCount),
      videoCount: numberFrom(channel.statistics?.videoCount),
    });
  }

  const videos = rawVideos
    .map((video) => normalizeVideo(video, channels.get(video.snippet?.channelId), videoTopicMap.get(video.id)))
    .filter(Boolean)
    .sort((a, b) => b.views - a.views)
    .slice(0, 30);

  const value = {
    videos,
    channels: [...channels.values()],
    range,
    windowHours,
    updatedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, { createdAt: Date.now(), value });
  return { ...value, cache: "miss" };
}

function mergeById(items) {
  const map = new Map();
  for (const item of items) {
    if (item?.id && !map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

function normalizeRange(value) {
  return value === "24h" || value === "3d" || value === "7d" ? value : "7d";
}

function rangeToHours(range) {
  if (range === "24h") return 24;
  if (range === "3d") return 72;
  return 168;
}

function normalizeVideo(video, channel, topic) {
  const snippet = video.snippet || {};
  const stats = video.statistics || {};
  const durationSeconds = parseDuration(video.contentDetails?.duration || "PT0S");
  const publishedAt = snippet.publishedAt ? new Date(snippet.publishedAt) : new Date();
  const publishedHoursAgo = Math.max(1, Math.round((Date.now() - publishedAt.getTime()) / 36e5));
  const views = numberFrom(stats.viewCount);
  const subscribers = channel?.subscribers || 0;
  const vph = Math.round(views / publishedHoursAgo);
  const type = durationSeconds > 0 && durationSeconds <= 75 ? "short" : "long";
  const growth24h = Math.round(Math.min(views, vph * 24));
  const growth3d = Math.round(Math.min(views, vph * 72));
  const growth7d = Math.round(Math.min(views, vph * 168));
  const thumbnail =
    snippet.thumbnails?.standard?.url ||
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url ||
    snippet.thumbnails?.maxres?.url ||
    "";

  return {
    id: video.id,
    channelId: snippet.channelId,
    type,
    topic: topic || "YouTube 趋势",
    title: snippet.title || "Untitled video",
    channel: snippet.channelTitle || channel?.name || "Unknown Channel",
    thumbnail,
    views,
    subscribers,
    growth24h,
    growth3d,
    growth7d,
    vph,
    publishedHoursAgo,
    likes: numberFrom(stats.likeCount),
    comments: numberFrom(stats.commentCount),
    reason: buildReason({ views, subscribers, vph, publishedHoursAgo, type }),
    url: `https://www.youtube.com/watch?v=${video.id}`,
    source: "youtube-api",
  };
}

function buildReason({ views, subscribers, vph, publishedHoursAgo, type }) {
  const ratio = subscribers > 0 ? views / subscribers : 0;
  if (ratio >= 3 && subscribers < 100000) {
    return `真实 YouTube 数据：低粉频道播放/订阅比约 ${ratio.toFixed(1)}x，适合作为低粉高播机会跟踪。`;
  }
  if (vph >= 10000) {
    return `真实 YouTube 数据：当前估算 VPH 约 ${formatCompact(vph)}，短期播放速度较高。`;
  }
  if (publishedHoursAgo <= 72) {
    return `真实 YouTube 数据：${type === "short" ? "Shorts" : "长视频"} 发布时间较新，可继续观察早期增长。`;
  }
  return "真实 YouTube 数据：已纳入机会池，可结合标题、封面和频道体量继续判断。";
}

async function youtube(resource, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  url.searchParams.set("key", API_KEY);

  if (process.platform === "win32") {
    return powershellJson(url.toString());
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const body = await response.json();
    if (!response.ok) {
      const message = body?.error?.message || `YouTube API request failed: ${response.status}`;
      throw new Error(message);
    }
    return body;
  } catch (error) {
    return powershellJson(url.toString());
  }
}

async function powershellJson(url) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "$u = $env:YT_REQUEST_URL",
    "$response = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 45",
    "[Console]::Out.Write($response.Content)",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: { ...process.env, YT_REQUEST_URL: url },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 60000,
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(stderr || error.message || "PowerShell request failed");
  }
}

function parseDuration(value) {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function numberFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function formatCompact(value) {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
  if (value >= 10000) return `${Math.round(value / 10000)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
