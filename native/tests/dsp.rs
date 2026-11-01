use carlab_engine_lab::config::{EngineConfig, EngineState, PhysicalAudioState};
use carlab_engine_lab::dsp::EngineDsp;
use serde_json::json;
const SR: f64 = 24000.0;
fn config(value: serde_json::Value) -> EngineConfig {
    let mut base = serde_json::to_value(EngineConfig::default()).unwrap();
    for (k, v) in value.as_object().unwrap() {
        base[k] = v.clone();
    }
    EngineConfig::from_value(&base).unwrap()
}
fn render(dsp: &mut EngineDsp, frames: usize, block: usize) -> (Vec<f32>, Vec<f32>) {
    let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
    for start in (0..frames).step_by(block) {
        let end = (start + block).min(frames);
        dsp.process(&mut left[start..end], &mut right[start..end]);
    }
    (left, right)
}
fn rms(a: &[f32]) -> f64 {
    (a.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / a.len().max(1) as f64).sqrt()
}
fn physical() -> PhysicalAudioState {
    PhysicalAudioState {
        boost_bar: 0.4,
        fuel_cut: false,
        intake_pressure_bar: 1.4,
        exhaust_pressure_bar: 1.8,
        exhaust_mass_flow_kgs: 0.1,
        exhaust_temperature_k: 950.0,
        cycle_energy_scale: 0.9,
        burn_duration_scale: 1.1,
        combustion_phase_deg: 2.0,
        residual_fraction: 0.08,
        cycle_index: 3.0,
    }
}
fn set(dsp: &mut EngineDsp, rpm: f64, load: f64, throttle: f64, p: Option<PhysicalAudioState>) {
    let actual = p.is_some();
    dsp.set_state(
        &EngineState {
            rpm,
            load,
            throttle,
            physical: p,
        },
        actual,
    );
}
#[test]
fn cadence_is_one_event_per_cylinder_per_two_revolutions() {
    let c = config(
        json!({"idleRpm":1200,"roughness":0,"timingJitter":0,"irregularity":0,"lowBody":0,"wear":0}),
    );
    let mut d = EngineDsp::new(SR, c);
    set(&mut d, 1200.0, 0.6, 0.6, None);
    render(&mut d, 24000, 128);
    let t = d.get_telemetry();
    assert!((t.firing_events as i64 - 40).abs() <= 1);
    assert_eq!(t.firing_hz, 40.0);
    assert!((t.cycle - 10.0).abs() < 1e-8);
}
#[test]
fn sample_output_is_independent_of_host_partition() {
    let c = config(
        json!({"roughness":0.75,"wear":0.8,"timingJitter":0.9,"perspective":"cabin","combustionDetail":1}),
    );
    let (mut a, mut b) = (EngineDsp::new(SR, c.clone()), EngineDsp::new(SR, c));
    set(&mut a, 850.0, 0.12, 0.08, None);
    set(&mut b, 850.0, 0.12, 0.08, None);
    let x = render(&mut a, 16800, 128);
    let y = render(&mut b, 16800, 317);
    assert_eq!(x, y);
    assert!(rms(&x.0) > 0.005);
    assert_eq!(
        a.get_telemetry().firing_events,
        b.get_telemetry().firing_events
    );
}
#[test]
fn detailed_pulse_time_constants_change_with_rpm_without_changing_event_clock() {
    let c = config(json!({"idleRpm":1200,"roughness":0,"timingJitter":0,"combustionDetail":1}));
    let mut d = EngineDsp::new(SR, c);
    set(&mut d, 1200.0, 0.5, 0.5, None);
    render(&mut d, 12000, 128);
    let low = d.get_pulse_diagnostics();
    d.set_state(
        &EngineState {
            rpm: 6000.0,
            load: 0.5,
            throttle: 0.5,
            physical: None,
        },
        true,
    );
    render(&mut d, 12000, 128);
    let high = d.get_pulse_diagnostics();
    assert!(high.blowdown_ms < low.blowdown_ms);
    assert!(high.flow_ms < low.flow_ms);
    assert!(high.intake_ms < low.intake_ms);
    assert!((d.get_telemetry().firing_hz - 200.0).abs() < 0.01);
}
#[test]
fn shared_dfco_cuts_combustion_but_retains_flow_noise() {
    let c = config(
        json!({"exhaustGain":1,"intakeGain":0,"mechanicalGain":0,"turboGain":0,"lowBody":0}),
    );
    let mut a = EngineDsp::new(SR, c.clone());
    let mut b = EngineDsp::new(SR, c);
    let mut p = physical();
    p.fuel_cut = true;
    p.boost_bar = 0.0;
    set(&mut a, 3200.0, 0.03, 0.0, Some(p.clone()));
    p.exhaust_mass_flow_kgs = 0.0;
    set(&mut b, 3200.0, 0.03, 0.0, Some(p));
    let x = render(&mut a, 12000, 128);
    let y = render(&mut b, 12000, 128);
    assert_eq!(a.get_telemetry().combustion_events, 0);
    assert!(a.get_telemetry().firing_events > 0);
    assert!(rms(&x.0) > 0.0001);
    assert_eq!(rms(&y.0), 0.0);
}
#[test]
fn shared_boost_and_cycle_variation_are_authoritative() {
    let a = config(json!({"roughness":0,"timingJitter":0,"wear":0,"irregularity":0,"boostBar":0}));
    let b = config(json!({"roughness":1,"timingJitter":1,"wear":1,"irregularity":1,"boostBar":0}));
    let (mut x, mut y) = (EngineDsp::new(SR, a), EngineDsp::new(SR, b));
    set(&mut x, 3000.0, 0.7, 0.7, Some(physical()));
    set(&mut y, 3000.0, 0.7, 0.7, Some(physical()));
    let output_a = render(&mut x, 18000, 128);
    let output_b = render(&mut y, 18000, 157);
    assert_eq!(output_a, output_b);
    let t = x.get_telemetry();
    assert!((t.boost - 0.4).abs() < 1e-10);
    assert!(t.turbo_rpm > 0.0);
    assert_eq!(x.get_character_telemetry().weak_combustions, 0);
    let p = t.physical.unwrap();
    assert_eq!(p.cycle_energy_scale, 0.9);
    assert_eq!(p.burn_duration_scale, 1.1);
    assert!((p.combustion_phase_deg - 2.0).abs() < 1e-12);
}
#[test]
fn manual_mode_ignores_physical_metadata() {
    let c = EngineConfig::default();
    let (mut a, mut b) = (EngineDsp::new(SR, c.clone()), EngineDsp::new(SR, c));
    a.set_state(
        &EngineState {
            rpm: 2800.0,
            load: 0.6,
            throttle: 0.7,
            physical: Some(physical()),
        },
        false,
    );
    b.set_state(
        &EngineState {
            rpm: 2800.0,
            load: 0.6,
            throttle: 0.7,
            physical: None,
        },
        false,
    );
    assert_eq!(render(&mut a, 12000, 128), render(&mut b, 12000, 137));
    assert!(a.get_telemetry().physical.is_none());
}
#[test]
fn each_source_can_be_muted_in_all_perspectives() {
    for perspective in ["exhaust", "engine", "cabin", "roadside"] {
        let c = config(
            json!({"perspective":perspective,"exhaustGain":0,"intakeGain":0,"mechanicalGain":0,"turboGain":0}),
        );
        let mut d = EngineDsp::new(SR, c);
        set(&mut d, 5200.0, 0.9, 1.0, Some(physical()));
        let x = render(&mut d, 12000, 128);
        assert_eq!(rms(&x.0), 0.0);
        assert_eq!(rms(&x.1), 0.0);
    }
}
#[test]
fn configuration_and_temperature_transitions_remain_bounded_and_dc_controlled() {
    let mut d = EngineDsp::new(SR, EngineConfig::default());
    set(&mut d, 4400.0, 0.8, 0.8, Some(physical()));
    render(&mut d, 12000, 128);
    for perspective in ["cabin", "roadside", "engine", "exhaust"] {
        let c = config(
            json!({"perspective":perspective,"exhaustLength":0.15,"headerLength":2,"pipeDiameter":140,"lowBody":1}),
        );
        d.set_config(&c);
        let mut p = physical();
        p.exhaust_temperature_k = 1750.0;
        p.exhaust_mass_flow_kgs = 1.2;
        set(&mut d, 8500.0, 1.0, 1.0, Some(p));
        let x = render(&mut d, 12000, 157);
        assert!(
            x.0.iter()
                .chain(&x.1)
                .all(|v| v.is_finite() && v.abs() < 1.0)
        );
        let mean = x.0.iter().map(|v| *v as f64).sum::<f64>() / x.0.len() as f64;
        assert!(mean.abs() < 0.05);
    }
}
#[test]
fn stop_decay_and_mismatched_output_blocks_do_not_leave_stale_samples() {
    let mut d = EngineDsp::new(SR, EngineConfig::default());
    set(&mut d, 2400.0, 0.8, 0.8, None);
    render(&mut d, 12000, 128);
    d.trigger("stop");
    let x = render(&mut d, 48000, 128);
    assert!(rms(&x.0[40000..]) < 0.00001);
    let (mut left, mut right) = ([9.0; 32], [9.0; 47]);
    d.process(&mut left, &mut right);
    assert!(right[32..].iter().all(|v| *v == 0.0));
}
