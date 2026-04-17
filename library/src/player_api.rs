//! HTTP proxy to the player backend. Holds both an async and a blocking
//! reqwest client — the former for short-lived results POSTs, the latter for
//! the long-lived m4s pull fed to the decoder.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::config::BACKEND_URL;

#[derive(Debug, Clone)]
pub struct StreamUrls {
    pub post_url: String,
    pub header_url: String,
    pub segment_url: String,
}

#[derive(Debug, Deserialize)]
pub struct VideoInfo {
    pub id: i32,
    pub name: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub stream_status: String,
}

pub struct PlayerApi {
    async_client: reqwest::Client,
    blocking_client: reqwest::blocking::Client,
}

impl PlayerApi {
    pub fn new() -> Result<Self> {
        let async_client = reqwest::Client::builder()
            .pool_max_idle_per_host(4)
            .timeout(Duration::from_secs(10))
            .build()
            .context("async reqwest client")?;
        let blocking_client = reqwest::blocking::Client::builder()
            .pool_max_idle_per_host(2)
            .build()
            .context("blocking reqwest client")?;
        Ok(Self { async_client, blocking_client })
    }

    pub fn get_stream_urls(&self, source_id: i32) -> StreamUrls {
        StreamUrls {
            post_url: format!("{BACKEND_URL}/bboxes/"),
            header_url: format!("{BACKEND_URL}/progressive/{source_id}/progressive.mp4"),
            segment_url: format!("{BACKEND_URL}/progressive/{source_id}/prog.m4s"),
        }
    }

    pub async fn get_video_info(&self, source_id: i32) -> Result<VideoInfo> {
        let url = format!("{BACKEND_URL}/videos/{source_id}");
        let resp = self.async_client.get(&url).send().await.with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            bail!("video info HTTP {}", resp.status());
        }
        resp.json::<VideoInfo>().await.context("decoding VideoInfo")
    }

    pub async fn post_results(&self, url: &str, json: String) -> Result<String> {
        let resp = self
            .async_client
            .post(url)
            .header("Content-Type", "application/json")
            .body(json)
            .send()
            .await
            .context("POST /bboxes/")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("backend rejected bboxes (HTTP {status}): {body}");
        }
        resp.text().await.context("reading /bboxes/ body")
    }

    pub fn fetch_header_blocking(&self, url: &str) -> Result<Vec<u8>> {
        let resp = self.blocking_client.get(url).send().with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            bail!("header HTTP {}", resp.status());
        }
        Ok(resp.bytes().context("reading header bytes")?.to_vec())
    }
}

impl PlayerApi {
    pub fn blocking_client(&self) -> &reqwest::blocking::Client { &self.blocking_client }
}
