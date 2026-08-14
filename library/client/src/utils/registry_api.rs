use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;

use crate::source::PostResultsOutput;

const CLIENT_TIMEOUT: Duration = Duration::from_secs(10);

/// Backend connection info, cooked in at build time. `url` is the bare backend origin with NO path
/// prefix (e.g. `http://127.0.0.1:8702`). The backend has no authentication, so there is no token.
#[derive(Clone)]
pub struct B2BCredentials {
    pub url: String,
}

/// The backend endpoints a single source talks to.
#[derive(Clone)]
pub struct SourceUrls {
    pub prog_init_url: String,
    pub prog_segment_url: String,
    pub results_url: String,
}

pub struct SourceInformation {
    pub id: u32,
    pub name: String,
    pub online: bool,
}

/// Subset of the backend's `VideoInfo` we care about.
#[derive(Deserialize)]
struct VideoInfo {
    id: u32,
    name: String,
    stream_status: String,
}

/// `POST /bboxes/` response: the stored bboxes echoed back with their timestamps.
#[derive(Deserialize)]
struct PostResultsResponse {
    bboxes: Vec<ResultBBox>,
}

/// One echoed bbox: its client `id` and the backend's assigned wall-clock time.
#[derive(Deserialize)]
struct ResultBBox {
    id: String,
    absolute_timestamp_ms: i64,
}

/// HTTP access to the backend. One async client for short calls, one blocking
/// client for the long-lived progressive pull.
#[derive(Clone)]
pub struct Registry {
    async_client: reqwest::Client,
    blocking_client: reqwest::blocking::Client,
    credentials: B2BCredentials,
}

impl Registry {
    pub fn new(credentials: B2BCredentials) -> Result<Self> {
        let async_client = reqwest::Client::builder()
            .timeout(CLIENT_TIMEOUT)
            .build()
            .context("build async client")?;
        // No total timeout — the prog.m4s pull is endless; bound connect and rely
        // on TCP keepalive to detect a dead peer.
        let blocking_client = reqwest::blocking::Client::builder()
            .connect_timeout(CLIENT_TIMEOUT)
            .tcp_keepalive(CLIENT_TIMEOUT)
            .build()
            .context("build blocking client")?;
        Ok(Self {
            async_client,
            blocking_client,
            credentials,
        })
    }

    fn base(&self) -> &str {
        self.credentials.url.trim_end_matches('/')
    }

    /// `GET /videos/` → one `SourceInformation` per video (online = streaming).
    pub async fn sources_information(&self) -> Result<Vec<SourceInformation>> {
        let url = format!("{}/videos/", self.base());
        let videos: Vec<VideoInfo> = self
            .async_client
            .get(url)
            .send()
            .await
            .context("GET /videos/")?
            .error_for_status()
            .context("GET /videos/ status")?
            .json()
            .await
            .context("decode /videos/ body")?;
        Ok(videos
            .into_iter()
            .map(|v| SourceInformation {
                id: v.id,
                name: v.name,
                online: v.stream_status == "streaming",
            })
            .collect())
    }

    /// Build the per-source backend URLs.
    pub async fn urls(&self, source_id: u32) -> Result<SourceUrls> {
        let base = self.base();
        Ok(SourceUrls {
            prog_init_url: format!("{base}/progressive/{source_id}/progressive.mp4"),
            prog_segment_url: format!("{base}/progressive/{source_id}/prog.m4s"),
            results_url: format!("{base}/bboxes/"),
        })
    }

    /// `POST /bboxes/` with the host's raw JSON `body`. Returns one
    /// `PostResultsOutput` per echoed bbox; the backend's single
    /// `absolute_timestamp_ms` is copied into both start and end.
    pub async fn post_results(&self, url: String, body: String) -> Result<Vec<PostResultsOutput>> {
        let response: PostResultsResponse = self
            .async_client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .context("POST /bboxes/")?
            .error_for_status()
            .context("POST /bboxes/ status")?
            .json()
            .await
            .context("decode /bboxes/ response")?;

        Ok(response
            .bboxes
            .into_iter()
            .map(|b| PostResultsOutput {
                id: b.id,
                timestamp: b.absolute_timestamp_ms,
            })
            .collect())
    }

    pub fn async_client(&self) -> &reqwest::Client {
        &self.async_client
    }

    pub fn blocking_client(&self) -> &reqwest::blocking::Client {
        &self.blocking_client
    }
}
