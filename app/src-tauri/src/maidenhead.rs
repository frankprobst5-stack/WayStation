//! Maidenhead grid square -> lat/lon centroid.
//!
//! Mirrors `app/src/lib/maidenhead.ts`. Duplicated rather than shared
//! because this runs in the Rust ingest worker, independently of the
//! frontend — the algorithm is a fixed, decades-old standard, so drift
//! risk between the two copies is low.

pub fn grid_square_to_lat_lon(grid: &str) -> Option<(f64, f64)> {
    let g: Vec<char> = grid.trim().to_uppercase().chars().collect();
    if g.len() < 4 {
        return None;
    }
    if !g[0].is_ascii_uppercase() || !('A'..='R').contains(&g[0]) {
        return None;
    }
    if !('A'..='R').contains(&g[1]) || !g[2].is_ascii_digit() || !g[3].is_ascii_digit() {
        return None;
    }

    let field_lon = (g[0] as u32 - 'A' as u32) as f64;
    let field_lat = (g[1] as u32 - 'A' as u32) as f64;
    let square_lon = g[2].to_digit(10)? as f64;
    let square_lat = g[3].to_digit(10)? as f64;

    let mut lon = field_lon * 20.0 - 180.0 + square_lon * 2.0;
    let mut lat = field_lat * 10.0 - 90.0 + square_lat;

    if g.len() >= 6 && ('A'..='X').contains(&g[4]) && ('A'..='X').contains(&g[5]) {
        let sub_lon = (g[4] as u32 - 'A' as u32) as f64;
        let sub_lat = (g[5] as u32 - 'A' as u32) as f64;
        lon += sub_lon * 5.0 / 60.0 + 2.5 / 60.0;
        lat += sub_lat * 2.5 / 60.0 + 1.25 / 60.0;
    } else {
        lon += 1.0;
        lat += 0.5;
    }

    Some((lat, lon))
}
