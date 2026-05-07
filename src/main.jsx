import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BellRing,
  Bookmark,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleGauge,
  Flame,
  LayoutDashboard,
  ListFilter,
  PlaySquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Star,
  Tags,
  TrendingUp,
  Youtube,
} from "lucide-react";
import {
  seedVideos as fallbackVideos,
  seedChannels as fallbackChannels,
  watchRules,
  scoreVideo,
  formatCompact,
  formatAge,
} from "./sampleData";
import "./styles.css";

const STORAGE_KEY = "yt-opportunity-hub-mvp";
const DATA_API = "/api/opportunities";
const USE_REAL_API = import.meta.env.VITE_USE_YOUTUBE_API === "true";

function rangeLabel(value) {
  if (value === "24h") return "24 小时";
  if (value === "3d") return "3 天";
  return "7 天";
}

function rangeGrowthKey(value) {
  if (value === "24h") return "growth24h";
  if (value === "3d") return "growth3d";
  return "growth7d";
}

function usePersistentState() {
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {
      // Local persistence is a convenience, not a runtime dependency.
    }
    return {
      savedVideoIds: [],
      savedChannelIds: [],
      ruleIds: ["low-sub-viral", "shorts-velocity"],
      notes: {},
    };
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  return [state, setState];
}

function App() {
  const [workspace, setWorkspace] = usePersistentState();
  const [contentType, setContentType] = useState("all");
  const [range, setRange] = useState("7d");
  const [query, setQuery] = useState("");
  const [lowSubOnly, setLowSubOnly] = useState(false);
  const [sortBy, setSortBy] = useState("score");
  const [selectedVideoId, setSelectedVideoId] = useState("");
  const [videos, setVideos] = useState(fallbackVideos);
  const [channels, setChannels] = useState(fallbackChannels);
  const [apiStatus, setApiStatus] = useState({
    loading: true,
    source: "loading",
    message: "正在连接 YouTube Data API",
    updatedAt: "",
  });

  async function loadYoutubeData(refresh = false, requestedRange = range) {
    if (!USE_REAL_API) {
      setVideos(fallbackVideos);
      setChannels(fallbackChannels);
      setApiStatus({
        loading: false,
        source: "fallback",
        message: `${rangeLabel(requestedRange)} 样本数据 · 如需真实数据请配置 VITE_USE_YOUTUBE_API=true 和 YOUTUBE_API_KEY`,
        updatedAt: "",
      });
      return;
    }

    setApiStatus((current) => ({
      ...current,
      loading: true,
      message: refresh ? `正在刷新 ${rangeLabel(requestedRange)} 真实 YouTube 数据` : `正在加载 ${rangeLabel(requestedRange)} 真实 YouTube 数据`,
    }));

    try {
      const health = await fetch("/api/health");
      if (health.ok) {
        const healthPayload = await health.json();
        if (healthPayload && healthPayload.hasKey === false) {
          throw new Error("未配置 YOUTUBE_API_KEY");
        }
      }

      const params = new URLSearchParams({ range: requestedRange });
      if (refresh) params.set("refresh", "1");
      const response = await fetch(`${DATA_API}?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || "YouTube API 数据加载失败");
      }
      if (!payload.videos?.length) {
        throw new Error("YouTube API 暂无可展示视频");
      }

      setVideos(payload.videos);
      setChannels(payload.channels?.length ? payload.channels : fallbackChannels);
      setApiStatus({
        loading: false,
        source: "youtube",
        message: payload.cache === "hit" ? `${rangeLabel(payload.range)} 真实数据 · 缓存命中` : `${rangeLabel(payload.range)} 真实数据 · 刚刚更新`,
        updatedAt: payload.updatedAt,
      });
    } catch (error) {
      setVideos(fallbackVideos);
      setChannels(fallbackChannels);
      setApiStatus({
        loading: false,
        source: "fallback",
        message: `${rangeLabel(requestedRange)} 已回落到样本数据：${error.message}`,
        updatedAt: "",
      });
    }
  }

  useEffect(() => {
    loadYoutubeData(false, range);
  }, [range]);

  useEffect(() => {
    if (sortBy === "views" && lowSubOnly) {
      setLowSubOnly(false);
    }
  }, [sortBy, lowSubOnly]);

  const enrichedVideos = useMemo(
    () => {
      const rangeKey = rangeGrowthKey(range);
      const channelById = new Map(channels.map((channel) => [channel.id, channel]));
      const channelStats = videos.reduce((stats, video) => {
        const current = stats.get(video.channelId) || { periodTotal: 0, periodMax: 0, allTimeTotal: 0, allTimeMax: 0 };
        const periodViews = Number(video[rangeKey] || 0);
        stats.set(video.channelId, {
          periodTotal: current.periodTotal + periodViews,
          periodMax: Math.max(current.periodMax, periodViews),
          allTimeTotal: current.allTimeTotal + Number(video.views || 0),
          allTimeMax: Math.max(current.allTimeMax, Number(video.views || 0)),
        });
        return stats;
      }, new Map());

      return videos.map((video) => {
        const stats = channelStats.get(video.channelId) || { periodTotal: 0, periodMax: 0, allTimeTotal: 0, allTimeMax: 0 };
        const channel = channelById.get(video.channelId);
        return {
        ...video,
        score: scoreVideo(video),
        saved: workspace.savedVideoIds.includes(video.id),
          periodViews: Number(video[rangeKey] || 0),
          channelPeriodTotalViews: stats.periodTotal,
          channelPeriodMaxViews: stats.periodMax,
          channelAllTimeTotalViews: Number(channel?.views || 0) || stats.allTimeTotal,
          channelAllTimeMaxViews: stats.allTimeMax,
        };
      });
    },
    [channels, range, videos, workspace.savedVideoIds],
  );

  useEffect(() => {
    if (!selectedVideoId && enrichedVideos[0]) {
      setSelectedVideoId(enrichedVideos[0].id);
    }
    if (selectedVideoId && enrichedVideos.length && !enrichedVideos.some((video) => video.id === selectedVideoId)) {
      setSelectedVideoId(enrichedVideos[0].id);
    }
  }, [enrichedVideos, selectedVideoId]);

  const filteredVideos = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const items = enrichedVideos.filter((video) => {
      const matchesType = contentType === "all" || video.type === contentType;
      const matchesQuery =
        !normalized ||
        video.title.toLowerCase().includes(normalized) ||
        video.channel.toLowerCase().includes(normalized) ||
        video.topic.toLowerCase().includes(normalized);
      const matchesLowSub = sortBy === "views" || sortBy === "siteViews" || !lowSubOnly || video.subscribers < 150000;
      return matchesType && matchesQuery && matchesLowSub;
    });

    const sortableItems =
      sortBy === "views" || sortBy === "siteViews"
        ? Array.from(
            items
              .reduce((byChannel, video) => {
                const current = byChannel.get(video.channelId);
                const value = sortBy === "siteViews" ? video.views : video.periodViews;
                const currentValue = current ? (sortBy === "siteViews" ? current.views : current.periodViews) : -1;
                if (
                  !current ||
                  value > currentValue ||
                  (value === currentValue && video.views > current.views)
                ) {
                  byChannel.set(video.channelId, video);
                }
                return byChannel;
              }, new Map())
              .values(),
          )
        : items;

    const rangeKey = rangeGrowthKey(range);
    return sortableItems.sort((a, b) => {
      if (sortBy === "growth") return b[rangeKey] - a[rangeKey];
      if (sortBy === "vph") return b.vph - a.vph;
      if (sortBy === "views") {
        return (
          b.channelPeriodMaxViews - a.channelPeriodMaxViews ||
          b.channelPeriodTotalViews - a.channelPeriodTotalViews ||
          b.periodViews - a.periodViews ||
          b.views - a.views
        );
      }
      if (sortBy === "siteViews") {
        return (
          b.views - a.views ||
          b.channelAllTimeTotalViews - a.channelAllTimeTotalViews
        );
      }
      return b.score - a.score;
    });
  }, [contentType, enrichedVideos, lowSubOnly, query, range, sortBy]);

  const selectedVideo = enrichedVideos.find((video) => video.id === selectedVideoId) || filteredVideos[0] || enrichedVideos[0];
  const savedVideos = enrichedVideos.filter((video) => workspace.savedVideoIds.includes(video.id));
  const topScore = enrichedVideos.length ? Math.max(...enrichedVideos.map((video) => video.score)) : 0;
  const hotToday = enrichedVideos.filter((video) => video.score >= 80).length;

  function toggleSave(videoId) {
    setWorkspace((current) => {
      const exists = current.savedVideoIds.includes(videoId);
      return {
        ...current,
        savedVideoIds: exists
          ? current.savedVideoIds.filter((id) => id !== videoId)
          : [videoId, ...current.savedVideoIds],
      };
    });
  }

  function toggleRule(ruleId) {
    setWorkspace((current) => {
      const exists = current.ruleIds.includes(ruleId);
      return {
        ...current,
        ruleIds: exists ? current.ruleIds.filter((id) => id !== ruleId) : [...current.ruleIds, ruleId],
      };
    });
  }

  function addChannel(channelId) {
    setWorkspace((current) => ({
      ...current,
      savedChannelIds: current.savedChannelIds.includes(channelId)
        ? current.savedChannelIds
        : [channelId, ...current.savedChannelIds],
    }));
  }

  function updateNote(value) {
    if (!selectedVideo) return;
    setWorkspace((current) => ({
      ...current,
      notes: {
        ...current.notes,
        [selectedVideo.id]: value,
      },
    }));
  }

  function selectVideo(videoId) {
    setSelectedVideoId(videoId);
    window.setTimeout(() => {
      if (window.matchMedia("(max-width: 1180px)").matches) {
        document.querySelector(".inspector")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 0);
  }

  if (!selectedVideo) {
    return (
      <div className="empty-screen">
        <Youtube size={32} />
        <h1>正在加载 YouTube 机会数据</h1>
        <p>{apiStatus.message}</p>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <a className="brand" href="/" aria-label="YT Opportunity Hub">
          <span className="brand-mark"><Youtube size={19} /></span>
          <span className="brand-copy">
            <strong>YT Hub</strong>
            <small>机会雷达</small>
          </span>
        </a>
        <nav className="nav-list">
          <NavItem active icon={<LayoutDashboard />} label="概览" />
          <NavItem icon={<Flame />} label="机会榜" />
          <NavItem icon={<Bookmark />} label="资产库" />
          <NavItem icon={<BellRing />} label="监听" />
          <NavItem icon={<Tags />} label="对标组" />
          <NavItem icon={<Settings />} label="设置" />
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>YouTube 爆款机会工作台</h1>
            <p>发现低粉高播、快速增长、值得持续追踪的视频和频道。</p>
          </div>
          <div className="topbar-actions">
            <span className={`data-status ${apiStatus.source}`}>
              {apiStatus.loading ? "加载中" : apiStatus.source === "youtube" ? "YouTube 实时" : "样本兜底"}
            </span>
            <button className="secondary-button" type="button" onClick={() => loadYoutubeData(true)} disabled={apiStatus.loading}>
              <RefreshCw size={16} className={apiStatus.loading ? "spin" : ""} />
              刷新
            </button>
            <div className="global-search">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、频道、赛道" />
            </div>
          </div>
        </header>

        <div className="data-note">
          <span>{apiStatus.message}</span>
          {apiStatus.updatedAt && <time>{new Date(apiStatus.updatedAt).toLocaleString()}</time>}
        </div>

        <section className="metrics-grid" aria-label="核心指标">
          <MetricCard icon={<Flame />} label="今日强机会" value={hotToday} hint="评分 >= 80" tone="red" />
          <MetricCard icon={<Bookmark />} label="已收藏视频" value={savedVideos.length} hint="本地工作台" tone="ink" />
          <MetricCard icon={<ChartNoAxesCombined />} label="监听频道" value={workspace.savedChannelIds.length} hint="持续追踪" tone="blue" />
          <MetricCard icon={<CircleGauge />} label="最高机会分" value={topScore} hint="可解释评分" tone="green" />
        </section>

        <section className="content-grid">
          <div className="ranking-panel">
            <div className="panel-header">
              <div>
                <h2>机会排行榜</h2>
                <p>{filteredVideos.length} 条样本，按当前筛选实时排序。</p>
              </div>
              <button className="secondary-button" type="button" onClick={() => setLowSubOnly((value) => !value)}>
                <ListFilter size={16} />
                {lowSubOnly ? "低粉优先" : "全部频道"}
              </button>
            </div>

            <div className="toolbar">
              <Segmented
                value={contentType}
                onChange={setContentType}
                options={[
                  ["all", "全部"],
                  ["short", "Shorts"],
                  ["long", "长视频"],
                ]}
              />
              <Segmented
                value={range}
                onChange={setRange}
                options={[
                  ["24h", "24h"],
                  ["3d", "3 天"],
                  ["7d", "7 天"],
                ]}
              />
              <label className="select-label">
                排序
                <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                  <option value="score">机会分</option>
                  <option value="growth">播放增量</option>
                  <option value="vph">VPH</option>
                  <option value="views">总播放</option>
                  <option value="siteViews">全站总播放量</option>
                </select>
                <ChevronDown size={14} />
              </label>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>视频</th>
                    <th>频道</th>
                    <th>播放</th>
                    <th>增量</th>
                    <th>VPH</th>
                    <th>机会分</th>
                    <th>动作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredVideos.map((video) => (
                    <VideoRow
                      key={video.id}
                      video={video}
                      selected={selectedVideo.id === video.id}
                      range={range}
                      sortBy={sortBy}
                      onSelect={() => selectVideo(video.id)}
                      onSave={() => toggleSave(video.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="inspector">
            <OpportunityInspector
              video={selectedVideo}
              note={workspace.notes[selectedVideo.id] || ""}
              saved={workspace.savedVideoIds.includes(selectedVideo.id)}
              channelSaved={workspace.savedChannelIds.includes(selectedVideo.channelId)}
              onSave={() => toggleSave(selectedVideo.id)}
              onSaveChannel={() => addChannel(selectedVideo.channelId)}
              onNote={updateNote}
            />

            <section className="side-card">
              <div className="side-title">
                <h3>监听规则</h3>
                <button type="button" className="icon-button" aria-label="新增规则"><Plus size={15} /></button>
              </div>
              <div className="rule-list">
                {watchRules.map((rule) => (
                  <button
                    className={`rule ${workspace.ruleIds.includes(rule.id) ? "active" : ""}`}
                    key={rule.id}
                    type="button"
                    onClick={() => toggleRule(rule.id)}
                  >
                    <span>{rule.title}</span>
                    <small>{rule.description}</small>
                  </button>
                ))}
              </div>
            </section>
          </aside>
        </section>

        <section className="asset-strip">
          <div>
            <h2>频道资产</h2>
            <p>真实频道可来自 YouTube Data API。点击频道可加入本地追踪列表。</p>
          </div>
          <div className="channel-list">
            {channels.map((channel) => (
              <button
                className={`channel-pill ${workspace.savedChannelIds.includes(channel.id) ? "saved" : ""}`}
                type="button"
                key={channel.id}
                onClick={() => addChannel(channel.id)}
              >
                <img src={channel.avatar} alt="" />
                <span>{channel.name}</span>
                {workspace.savedChannelIds.includes(channel.id) && <Check size={14} />}
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

function NavItem({ active = false, icon, label }) {
  return (
    <a className={`nav-item ${active ? "active" : ""}`} href={`#${label}`}>
      {React.cloneElement(icon, { size: 18 })}
      <span>{label}</span>
    </a>
  );
}

function MetricCard({ icon, label, value, hint, tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <div className="metric-icon">{React.cloneElement(icon, { size: 18 })}</div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <small>{hint}</small>
      </div>
    </article>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map(([key, label]) => (
        <button className={value === key ? "active" : ""} type="button" key={key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function VideoRow({ video, selected, range, sortBy, onSelect, onSave }) {
  const growthKey = rangeGrowthKey(range);
  const playbackValue = sortBy === "views" ? video.channelPeriodMaxViews : video.views;
  const playbackHint = sortBy === "views" ? `频道峰值/${rangeLabel(range)}` : sortBy === "siteViews" ? `全站热门/${rangeLabel(range)}` : "累计播放";
  return (
    <tr
      className={selected ? "selected" : ""}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      aria-label={`查看详情：${video.title}`}
    >
      <td className="video-cell">
        <button
          type="button"
          className="video-detail-button"
          onClick={(event) => {
            event.stopPropagation();
            onSelect();
          }}
        >
          <img src={video.thumbnail} alt="" />
          <span>
            <strong>{video.title}</strong>
            <small>
              <PlaySquare size={13} />
              {video.type === "short" ? "Shorts" : "长视频"} · {formatAge(video.publishedHoursAgo)}
            </small>
          </span>
        </button>
      </td>
      <td>
        <span className="channel-name">{video.channel}</span>
        <small className="muted">{formatCompact(video.subscribers)} 订阅</small>
      </td>
      <td>
        {formatCompact(playbackValue)}
        <small className="muted">{playbackHint}</small>
      </td>
      <td className="positive">+{formatCompact(video[growthKey])}</td>
      <td>{formatCompact(video.vph)}</td>
      <td>
        <Score score={video.score} />
      </td>
      <td>
        <button
          className={`save-button ${video.saved ? "saved" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSave();
          }}
          aria-label={video.saved ? "取消收藏" : "收藏视频"}
        >
          <Star size={15} fill={video.saved ? "currentColor" : "none"} />
        </button>
      </td>
    </tr>
  );
}

function Score({ score }) {
  const level = score >= 80 ? "strong" : score >= 65 ? "watch" : "normal";
  return (
    <span className={`score ${level}`}>
      <span style={{ width: `${score}%` }} />
      <strong>{score}</strong>
    </span>
  );
}

function OpportunityInspector({ video, note, saved, channelSaved, onSave, onSaveChannel, onNote }) {
  return (
    <section className="inspector-card">
      <div className="preview">
        <img src={video.thumbnail} alt="" />
        <span className={`type-chip ${video.type}`}>{video.type === "short" ? "Shorts" : "长视频"}</span>
      </div>
      <div className="inspector-body">
        <div className="scoreline">
          <Score score={video.score} />
          <span className="topic">{video.topic}</span>
        </div>
        <h2>{video.title}</h2>
        <p>{video.channel} · {formatCompact(video.subscribers)} 订阅 · 发布 {formatAge(video.publishedHoursAgo)}</p>

        <div className="detail-grid">
          <MetricMini label="播放量" value={formatCompact(video.views)} />
          <MetricMini label="24h 增量" value={`+${formatCompact(video.growth24h)}`} />
          <MetricMini label="播放/订阅" value={`${(video.views / Math.max(video.subscribers, 1)).toFixed(1)}x`} />
          <MetricMini label="VPH" value={formatCompact(video.vph)} />
        </div>

        <div className="reason-box">
          <TrendingUp size={16} />
          <span>{video.reason}</span>
        </div>

        <textarea value={note} onChange={(event) => onNote(event.target.value)} placeholder="写下复刻点、封面结构、标题套路或后续动作" />

        <div className="button-row">
          <button className="primary-button" type="button" onClick={onSave}>
            <Star size={16} fill={saved ? "currentColor" : "none"} />
            {saved ? "已收藏" : "收藏视频"}
          </button>
          <a className="secondary-button link-button" href={video.url || `https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer">
            <Youtube size={16} />
            打开原视频
          </a>
          <button className="secondary-button" type="button" onClick={onSaveChannel}>
            <Bookmark size={16} />
            {channelSaved ? "频道已追踪" : "追踪频道"}
          </button>
        </div>
      </div>
    </section>
  );
}

function MetricMini({ label, value }) {
  return (
    <div className="metric-mini">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
