//! Engine topology and acoustic inputs shared by native and WASM callers.
//! JSON field names follow the existing browser configuration contract.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineConfig {
    pub cylinders: usize,
    pub layout: String,
    pub bank_angle: f64,
    pub displacement: f64,
    pub compression: f64,
    pub idle_rpm: f64,
    pub redline: f64,
    pub cam: f64,
    pub irregularity: f64,
    pub roughness: f64,
    pub timing_jitter: f64,
    pub low_body: f64,
    pub wear: f64,
    pub combustion_detail: f64,
    pub perspective: String,
    pub exhaust_length: f64,
    pub header_length: f64,
    pub pipe_diameter: f64,
    pub muffler: f64,
    pub crossover: f64,
    pub intake_length: f64,
    pub temperature: f64,
    pub boost_bar: f64,
    pub turbo_size: f64,
    pub bov: f64,
    pub exhaust_gain: f64,
    pub intake_gain: f64,
    pub mechanical_gain: f64,
    pub turbo_gain: f64,
    pub firing_angles: Vec<f64>,
    pub firing_order: Vec<usize>,
    pub cylinder_banks: Vec<u8>,
    pub damping: f64,
    pub overrun: f64,
    pub inertia: f64,
    pub stereo_width: f64,
    pub seed: u32,
}
impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            cylinders: 4,
            layout: "inline".into(),
            bank_angle: 0.,
            displacement: 2.,
            compression: 10.5,
            idle_rpm: 850.,
            redline: 7200.,
            cam: 0.28,
            irregularity: 0.08,
            roughness: 0.12,
            timing_jitter: 0.1,
            low_body: 0.2,
            wear: 0.,
            combustion_detail: 0.4,
            perspective: "exhaust".into(),
            exhaust_length: 1.7,
            header_length: 0.58,
            pipe_diameter: 57.,
            muffler: 0.46,
            crossover: 0.,
            intake_length: 0.32,
            temperature: 540.,
            boost_bar: 0.,
            turbo_size: 0.4,
            bov: 0.5,
            exhaust_gain: 0.78,
            intake_gain: 0.3,
            mechanical_gain: 0.22,
            turbo_gain: 0.36,
            firing_angles: vec![0., 180., 360., 540.],
            firing_order: vec![1, 3, 4, 2],
            cylinder_banks: vec![0, 0, 0, 0],
            damping: 0.34,
            overrun: 0.22,
            inertia: 0.42,
            stereo_width: 0.72,
            seed: 23761,
        }
    }
}
fn bounded(source: &Value, key: &str, fallback: f64, lo: f64, hi: f64) -> f64 {
    source
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(lo, hi))
        .unwrap_or(fallback)
}
fn default_order(n: usize, layout: &str) -> Vec<usize> {
    match (n, layout) {
        (4, "boxer") => vec![1, 3, 2, 4],
        (4, _) => vec![1, 3, 4, 2],
        (3, _) => vec![1, 3, 2],
        (6, "inline") => vec![1, 5, 3, 6, 2, 4],
        _ => (1..=n).collect(),
    }
}
impl EngineConfig {
    /// Matches the TypeScript normalizer, including paired angle/order sorting
    /// and repair of malformed optional inputs rather than silently trusting JSON.
    pub fn from_value(source: &Value) -> Result<Self, String> {
        if !source.is_object() && !source.is_null() {
            return Err("Engine configuration must be an object".into());
        }
        let mut c = Self::default();
        c.cylinders = bounded(source, "cylinders", 4., 1., 12.).round() as usize;
        c.layout = source
            .get("layout")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "v" | "boxer" | "inline"))
            .unwrap_or("inline")
            .into();
        let angles = source.get("firingAngles").and_then(Value::as_array);
        let order = source.get("firingOrder").and_then(Value::as_array);
        let mut events: Vec<(f64, usize)> = Vec::new();
        if let (Some(aa), Some(oo)) = (angles, order) {
            if aa.len() == c.cylinders && oo.len() == c.cylinders {
                for (a, o) in aa.iter().zip(oo) {
                    let Some(a) = a
                        .as_f64()
                        .filter(|a| a.is_finite() && *a >= 0. && *a < 720.)
                    else {
                        events.clear();
                        break;
                    };
                    let Some(o) = o
                        .as_f64()
                        .filter(|o| o.fract() == 0. && *o >= 1. && *o <= c.cylinders as f64)
                    else {
                        events.clear();
                        break;
                    };
                    if events.iter().any(|(pa, po)| *pa == a || *po == o as usize) {
                        events.clear();
                        break;
                    }
                    events.push((a, o as usize));
                }
            }
        }
        if events.len() == c.cylinders {
            events.sort_by(|a, b| a.0.total_cmp(&b.0));
            c.firing_angles = events.iter().map(|p| p.0).collect();
            c.firing_order = events.iter().map(|p| p.1).collect();
        } else {
            c.firing_angles = (0..c.cylinders)
                .map(|i| i as f64 * 720. / c.cylinders as f64)
                .collect();
            c.firing_order = default_order(c.cylinders, &c.layout);
        }
        let banks = source
            .get("cylinderBanks")
            .and_then(Value::as_array)
            .and_then(|aa| {
                let b: Option<Vec<u8>> = aa
                    .iter()
                    .map(|v| v.as_f64().filter(|v| *v == 0. || *v == 1.).map(|v| v as u8))
                    .collect();
                b.filter(|b| {
                    b.len() == c.cylinders
                        && (c.cylinders == 1 || (b.contains(&0) && b.contains(&1)))
                })
            });
        c.cylinder_banks = if c.layout == "inline" {
            vec![0; c.cylinders]
        } else {
            banks.unwrap_or_else(|| (0..c.cylinders).map(|i| (i % 2) as u8).collect())
        };
        c.bank_angle = if c.layout == "inline" {
            0.
        } else {
            let fallback = if c.layout == "boxer" { 180. } else { 60. };
            source
                .get("bankAngle")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.)
                .map(|v| v.clamp(10., 180.))
                .unwrap_or(fallback)
        };
        macro_rules! set {
            ($field:ident,$key:literal,$lo:expr,$hi:expr) => {
                c.$field = bounded(source, $key, c.$field, $lo, $hi);
            };
        }
        set!(displacement, "displacement", 0.1, 12.);
        set!(compression, "compression", 6., 16.);
        set!(idle_rpm, "idleRpm", 400., 2400.);
        set!(redline, "redline", 2000., 18000.);
        c.redline = c.redline.max(c.idle_rpm + 500.);
        set!(cam, "cam", 0., 1.);
        set!(irregularity, "irregularity", 0., 1.);
        set!(roughness, "roughness", 0., 1.);
        set!(timing_jitter, "timingJitter", 0., 1.);
        set!(low_body, "lowBody", 0., 1.);
        set!(wear, "wear", 0., 1.);
        set!(combustion_detail, "combustionDetail", 0., 1.);
        set!(exhaust_length, "exhaustLength", 0.15, 4.);
        set!(header_length, "headerLength", 0.1, 2.);
        set!(pipe_diameter, "pipeDiameter", 20., 140.);
        set!(muffler, "muffler", 0., 1.);
        set!(crossover, "crossover", 0., 1.);
        set!(intake_length, "intakeLength", 0.05, 1.5);
        set!(temperature, "temperature", 100., 1000.);
        set!(boost_bar, "boostBar", 0., 2.5);
        set!(turbo_size, "turboSize", 0., 1.);
        set!(bov, "bov", 0., 1.);
        set!(exhaust_gain, "exhaustGain", 0., 1.);
        set!(intake_gain, "intakeGain", 0., 1.);
        set!(mechanical_gain, "mechanicalGain", 0., 1.);
        set!(turbo_gain, "turboGain", 0., 1.);
        set!(damping, "damping", 0., 1.);
        set!(overrun, "overrun", 0., 1.);
        set!(inertia, "inertia", 0., 1.);
        set!(stereo_width, "stereoWidth", 0., 1.);
        c.perspective = source
            .get("perspective")
            .and_then(Value::as_str)
            .filter(|v| matches!(*v, "exhaust" | "engine" | "cabin" | "roadside"))
            .unwrap_or("exhaust")
            .into();
        c.seed = bounded(source, "seed", 23761., 1., u32::MAX as f64).round() as u32;
        Ok(c)
    }
    pub fn normalize(self) -> Self {
        Self::from_value(&serde_json::to_value(self).unwrap_or(Value::Null)).unwrap_or_default()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PhysicalAudioState {
    pub boost_bar: f64,
    pub fuel_cut: bool,
    pub intake_pressure_bar: f64,
    pub exhaust_pressure_bar: f64,
    pub exhaust_mass_flow_kgs: f64,
    pub exhaust_temperature_k: f64,
    pub cycle_energy_scale: f64,
    pub burn_duration_scale: f64,
    pub combustion_phase_deg: f64,
    pub residual_fraction: f64,
    pub cycle_index: f64,
}
impl Default for PhysicalAudioState {
    fn default() -> Self {
        Self {
            boost_bar: 0.,
            fuel_cut: false,
            intake_pressure_bar: 1.01325,
            exhaust_pressure_bar: 1.01325,
            exhaust_mass_flow_kgs: 0.,
            exhaust_temperature_k: 813.15,
            cycle_energy_scale: 1.,
            burn_duration_scale: 1.,
            combustion_phase_deg: 0.,
            residual_fraction: 0.,
            cycle_index: 0.,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineState {
    pub rpm: f64,
    pub load: f64,
    pub throttle: f64,
    pub physical: Option<PhysicalAudioState>,
}
impl Default for EngineState {
    fn default() -> Self {
        Self {
            rpm: 850.,
            load: 0.14,
            throttle: 0.06,
            physical: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn normalization_preserves_sorted_event_pairs_and_bounds() {
        let c=EngineConfig::from_value(&json!({"cylinders":2,"layout":"v","firingAngles":[315,0],"firingOrder":[2,1],"displacement":999,"seed":0})).unwrap();
        assert_eq!(c.firing_angles, vec![0., 315.]);
        assert_eq!(c.firing_order, vec![1, 2]);
        assert_eq!(c.cylinder_banks, vec![0, 1]);
        assert_eq!(c.displacement, 12.);
        assert_eq!(c.seed, 1);
        assert_eq!(c.bank_angle, 60.);
    }
    #[test]
    fn malformed_topology_gets_complete_fresh_schedule() {
        let c = EngineConfig::from_value(
            &json!({"cylinders":3,"layout":"inline","firingAngles":[0,0,1],"firingOrder":[1,2,3]}),
        )
        .unwrap();
        assert_eq!(c.firing_angles, vec![0., 240., 480.]);
        assert_eq!(c.firing_order, vec![1, 3, 2]);
        assert_eq!(c.cylinder_banks, vec![0, 0, 0]);
    }
}
