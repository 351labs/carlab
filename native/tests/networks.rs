use carlab_engine_lab::gas_path::*;
use carlab_engine_lab::maps::*;
use carlab_engine_lab::thermal::*;
use serde_json::{Value, json};
fn near(a: f64, b: f64, t: f64) {
    assert!(
        (a - b).abs() <= t,
        "{a} differs from {b} by {} (limit{t})",
        (a - b).abs()
    );
}
fn isolated_config() -> ThermalConfig {
    normalize_thermal_config(
        &json!({"wallToCoolantWK":0,"wallToOilWK":0,"wallToExhaustWK":0,"exhaustToCoolantWK":0,"coolantToAmbientWK":0,"oilToAmbientWK":0,"exhaustToAmbientWK":0,"coolantMassFlowKgs":0,"oilMassFlowKgs":0}),
    )
}
#[test]
fn reservoir_mass_internal_energy_and_inlet_enthalpy_balance() {
    let mut r = IdealGasReservoir::new(0.003, 101325.0, 300.0, 1.35, 287.05).unwrap();
    let before = r.get_state();
    let inflow = ReservoirInflow {
        mass_flow_kgs: 0.001,
        temperature_k: 310.0,
    };
    let b = r.advance(0.1, &[inflow], 0.0005, 100.0).unwrap();
    let after = r.get_state();
    near(after.mass_kg, before.mass_kg + 0.0001 - 0.00005, 1e-17);
    near(b.energy_in_j, 0.0001 * r.cp * 310.0, 1e-12);
    near(b.energy_out_j, 0.00005 * r.cp * 300.0, 1e-12);
    near(
        after.internal_energy_j - before.internal_energy_j,
        b.energy_in_j - b.energy_out_j + 10.0,
        1e-12,
    );
    near(
        after.pressure_pa,
        after.mass_kg * 287.05 * after.temperature_k / 0.003,
        1e-9,
    );
    near(b.mass_residual_kg, 0.0, 1e-18);
    near(b.energy_residual_j, 0.0, 1e-12);
}
#[test]
fn reservoir_explicit_inventory_and_cooling_guards_are_reported() {
    let mut r = IdealGasReservoir::new(0.003, 101325.0, 300.0, 1.35, 287.05).unwrap();
    let before = r.get_state();
    let b = r.advance(1.0, &[], 100.0, -1e9).unwrap();
    let after = r.get_state();
    near(after.mass_kg, before.mass_kg * 0.8, 1e-16);
    assert!(
        b.limited_outflow_kg > 99.0 && b.limited_cooling_j > 0.0 && after.internal_energy_j > 0.0
    );
    assert!(r.advance(0.1, &[], 0.0, f64::NAN).is_err());
}
#[test]
fn signed_orifice_chokes_and_pressure_loss_has_quadratic_scaling() {
    let a = compressible_orifice_flow(200000.0, 400.0, 10000.0, 300.0, 0.001, 0.72, 1.35, 287.05)
        .unwrap();
    let b = compressible_orifice_flow(200000.0, 400.0, 50000.0, 300.0, 0.001, 0.72, 1.35, 287.05)
        .unwrap();
    near(a, b, 1e-15);
    let reverse =
        compressible_orifice_flow(10000.0, 300.0, 200000.0, 400.0, 0.001, 0.72, 1.35, 287.05)
            .unwrap();
    near(reverse, -a, 1e-15);
    let loss = exhaust_pressure_loss(0.1, 1.0, 0.06, 1.7, 2.0, 0.025).unwrap();
    near(
        exhaust_pressure_loss(0.2, 1.0, 0.06, 1.7, 2.0, 0.025).unwrap(),
        loss * 4.0,
        1e-9,
    );
    assert!(
        compressible_orifice_flow(-1.0, 300.0, 100000.0, 300.0, 0.001, 0.7, 1.35, 287.05).is_err()
    );
}
#[test]
fn gas_path_fills_progressively_and_conserves_external_mass_boundary() {
    let mut gas = GasPath::new(GasPathConfig::default()).unwrap();
    gas.reset(GasPathReset {
        intake_pressure_pa: Some(35000.0),
        ..Default::default()
    })
    .unwrap();
    let before = gas.get_state();
    let input = GasPathInput {
        rpm: 2500.0,
        throttle: 0.8,
        engine_displacement_m3: 0.002,
        volumetric_efficiency: 0.9,
        fuel_mass_flow_kgs: Some(0.002),
        exhaust_temperature_k: Some(900.0),
        ..Default::default()
    };
    let first = gas.step(0.0005, &input).unwrap();
    assert!(first.intake.pressure_pa > before.intake.pressure_pa);
    assert!(first.intake.pressure_pa < 101325.0);
    let after = gas.step(0.02, &input).unwrap();
    assert!(after.intake.pressure_pa > first.intake.pressure_pa);
    near(after.mass_balance_residual_kg, 0.0, 1e-16);
    near(after.energy_balance_residual_j, 0.0, 1e-9);
    let previous = gas.get_state();
    let dt = 0.001;
    let state = gas.step(dt, &input).unwrap();
    let mass_delta = state.intake.mass_kg + state.exhaust.mass_kg
        - previous.intake.mass_kg
        - previous.exhaust.mass_kg;
    near(
        mass_delta,
        (state.throttle_mass_flow_kgs + state.fuel_mass_flow_kgs - state.outlet_mass_flow_kgs) * dt,
        1e-16,
    );
}
#[test]
fn gas_heat_ledger_reports_actual_signed_applied_heat() {
    let mut gas = GasPath::new(GasPathConfig::default()).unwrap();
    let input = GasPathInput {
        rpm: 0.0,
        throttle: 0.0,
        engine_displacement_m3: 0.002,
        volumetric_efficiency: 0.9,
        cylinder_air_mass_flow_kgs: Some(0.0),
        intake_heat_w: Some(200.0),
        exhaust_heat_w: Some(-300.0),
        ..Default::default()
    };
    let s = gas.step(0.001, &input).unwrap();
    near(s.intake_heat_j, 0.2, 1e-15);
    near(s.exhaust_heat_j, -0.3, 1e-15);
    assert_eq!(s.limited_cooling_j, 0.0);
}
#[test]
fn thermal_isolated_heat_capacities_obey_analytic_energy_gain() {
    let cfg = isolated_config();
    let mut net = ThermalNetwork::new(cfg.clone());
    let before = net.get_state();
    let s = net
        .step(
            2.0,
            &ThermalLoads {
                gas_heat_w: Some(10000.0),
                friction_heat_w: Some(2000.0),
                ..Default::default()
            },
        )
        .unwrap();
    near(
        s.wall_temperature_k,
        before.wall_temperature_k + 20000.0 / cfg.wall_heat_capacity_jk,
        1e-10,
    );
    near(
        s.oil_temperature_k,
        before.oil_temperature_k + 4000.0 * cfg.friction_to_oil_fraction / cfg.oil_heat_capacity_jk,
        1e-10,
    );
    near(s.delta_stored_energy_j, 24000.0, 1e-7);
    near(s.energy_residual_j, 0.0, 1e-7);
}
#[test]
fn thermal_pair_exchange_matches_analytic_decay_without_energy_loss() {
    let mut cfg = isolated_config();
    cfg.initial_wall_temperature_k = 500.0;
    cfg.initial_coolant_temperature_k = 300.0;
    cfg.wall_heat_capacity_jk = 1000.0;
    cfg.coolant_heat_capacity_jk = 2000.0;
    cfg.wall_to_coolant_wk = 35.0;
    let mut net = ThermalNetwork::new(cfg);
    let s = net.step(30.0, &ThermalLoads::default()).unwrap();
    let q = 200.0 / (1.0 / 1000.0 + 1.0 / 2000.0)
        * (1.0 - (-35.0f64 * (1.0 / 1000.0 + 1.0 / 2000.0) * 30.0).exp());
    near(s.wall_temperature_k, 500.0 - q / 1000.0, 1e-10);
    near(s.coolant_temperature_k, 300.0 + q / 2000.0, 1e-10);
    near(s.energy_residual_j, 0.0, 1e-7);
}
#[test]
fn paired_exhaust_heat_enters_metal_once_and_preserves_distinct_gas_temperature() {
    let mut net = ThermalNetwork::new(isolated_config());
    let before = net.get_state();
    let s = net
        .step(
            0.2,
            &ThermalLoads {
                coupled_exhaust_gas_heat_w: Some(800.0),
                exhaust_gas_temperature_k: Some(1100.0),
                ..Default::default()
            },
        )
        .unwrap();
    near(s.delta_stored_energy_j, 160.0, 1e-7);
    near(s.exhaust_gas_to_wall_heat_w, 800.0, 1e-12);
    near(s.exhaust_gas_temperature_k, 1100.0, 1e-12);
    assert!(
        s.exhaust_wall_temperature_k < 500.0
            && s.exhaust_wall_temperature_k > before.exhaust_wall_temperature_k
    );
    near(s.energy_residual_j, 0.0, 1e-7);
}
#[test]
fn thermal_failure_rolls_back_and_config_changes_rebase_only_when_needed() {
    let mut cfg = isolated_config();
    cfg.wall_heat_capacity_jk = 100.0;
    let mut net = ThermalNetwork::new(cfg.clone());
    let before = serde_json::to_value(net.get_state()).unwrap();
    assert!(
        net.step(
            1.0,
            &ThermalLoads {
                gas_heat_w: Some(-1e12),
                ..Default::default()
            }
        )
        .is_err()
    );
    assert_eq!(serde_json::to_value(net.get_state()).unwrap(), before);
    assert!(net.step(61.0, &ThermalLoads::default()).is_err());
    net.step(1.0, &ThermalLoads::default()).unwrap();
    cfg.source = "Only provenance changed".into();
    net.set_config(cfg.clone());
    assert_eq!(net.get_state().elapsed_seconds, 1.0);
    cfg.wall_heat_capacity_jk = 200.0;
    net.set_config(cfg);
    assert_eq!(net.get_state().elapsed_seconds, 0.0);
    near(net.get_state().delta_stored_energy_j, 0.0, 1e-12);
}
fn sample_map() -> Value {
    json!({"schema":"carlab-calibration-map-1","kind":"ve","rpm":[1000,2000],"pressureBar":[1,2],"values":[[0.5,0.9],[0.7,1.1]],"axisUnits":{"rpm":"rpm","pressure":"bar-absolute"},"valueUnit":"fraction","extrapolation":"clamp","provenance":{"source":"assumed","label":"Original test grid","version":"test-1","calibratedAt":"2026-10-31","validation":{"label":"Synthetic interpolation contract","independent":false}}})
}
#[test]
fn map_bilinear_knots_midpoints_and_clamped_domains_preserve_declared_source() {
    let map = normalize_calibration_map(&sample_map(), CalibrationKind::Ve).unwrap();
    near(
        sample_calibration_map(&map, 1500.0, 1.5).unwrap().value,
        0.8,
        1e-14,
    );
    near(
        sample_calibration_map(&map, 1000.0, 1.0).unwrap().value,
        0.5,
        1e-14,
    );
    let sample = sample_calibration_map(&map, 500.0, 0.5).unwrap();
    assert!(sample.extrapolated);
    assert_eq!(sample.extrapolated_axes, vec!["rpm", "pressure"]);
    near(sample.value, 0.5, 1e-14);
    assert_eq!(sample.source, "assumed");
    assert!(!sample.provenance.validation.unwrap().independent);
    let uniform = create_assumed_ve_map(800.0, 7000.0, 0.85, true).unwrap();
    near(
        sample_calibration_map(&uniform, 3600.0, 2.0).unwrap().value,
        0.85,
        1e-14,
    );
}
#[test]
fn malformed_maps_fail_instead_of_silently_substituting_assumptions() {
    let mut x = sample_map();
    x["pressureBar"] = json!([1, 1]);
    assert!(normalize_calibration_map(&x, CalibrationKind::Ve).is_err());
    let mut x = sample_map();
    x["axisUnits"]["pressure"] = json!("bar-gauge");
    assert!(normalize_calibration_map(&x, CalibrationKind::Ve).is_err());
    let mut x = sample_map();
    x["values"][0] = json!([0.5]);
    assert!(normalize_calibration_map(&x, CalibrationKind::Ve).is_err());
    let mut x = sample_map();
    x["provenance"]["calibratedAt"] = json!("2026-13-01");
    assert!(normalize_calibration_map(&x, CalibrationKind::Ve).is_err());
    assert!(
        sample_calibration_map(
            &normalize_calibration_map(&sample_map(), CalibrationKind::Ve).unwrap(),
            f64::NAN,
            1.0
        )
        .is_err()
    );
    assert!(
        parse_calibration_bundle(
            &json!({"schema":"carlab-calibration-bundle-1","maps":{"unknown":{}}})
        )
        .is_err()
    );
}
#[test]
fn serialization_matches_existing_acronym_keys_and_defaults_are_normalized() {
    let cfg = ThermalConfig::default();
    let v = serde_json::to_value(&cfg).unwrap();
    assert_eq!(v["wallHeatCapacityJK"], 25000.0);
    assert_eq!(v["exhaustGasHeatCapacityJKgK"], 1100.0);
    assert_eq!(v["wallToCoolantWK"], 180.0);
    assert_eq!(normalize_thermal_config(&v), cfg);
    assert_eq!(
        normalize_gas_path_config(&json!({"intakeVolumeM3":-1})).intake_volume_m3,
        0.0002
    );
}
