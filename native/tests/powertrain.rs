use carlab_engine_lab::config::EngineConfig;
use carlab_engine_lab::powertrain::{
    PhysicalConfig, Powertrain, engine_geometry, evaluate_engine, get_cylinder_cycle,
    passive_clutch_impulse, transmitted_wheel_torque,
};
use serde_json::json;
fn near(a: f64, b: f64, relative: f64) {
    assert!(
        (a - b).abs() <= relative * a.abs().max(b.abs()).max(1.0),
        "{a} != {b}"
    );
}
#[test]
fn geometry_preserves_volume_and_si_dimensions() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::default_for(&e);
    let g = engine_geometry(&e, &p);
    near(g.displacement_m3, e.displacement * 0.001, 1e-14);
    near(
        std::f64::consts::PI * (g.bore_mm / 1000.0).powi(2) / 4.0
            * (g.stroke_mm / 1000.0)
            * e.cylinders as f64,
        g.displacement_m3,
        1e-14,
    );
    near(g.bore_mm / g.stroke_mm, p.bore_stroke_ratio, 1e-14);
    near(
        g.rod_length_mm / g.stroke_mm,
        p.rod_length_stroke_ratio,
        1e-14,
    );
}
#[test]
fn steady_work_torque_fuel_and_pressure_follow_the_same_cycle() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::default_for(&e);
    let c = get_cylinder_cycle(&e, &p, 3000.0, 0.7, None, 1.0).unwrap();
    let point = evaluate_engine(&e, &p, 3000.0, 0.7, 1.0).unwrap();
    near(
        point.torque_nm,
        c.net_work_j * e.cylinders as f64 / (4.0 * std::f64::consts::PI) - point.friction_torque_nm,
        1e-12,
    );
    near(
        point.power_kw,
        point.torque_nm * 3000.0 * std::f64::consts::TAU / 60.0 / 1000.0,
        1e-12,
    );
    near(
        point.fuel_mass_flow_kgs,
        c.fuel_mass_kg * e.cylinders as f64 * 3000.0 / 120.0,
        1e-12,
    );
    assert!((1..=3).contains(&c.calibration.iterations));
    assert_eq!(c.config.initial_pressure_pa, c.config.exhaust_pressure_pa);
    assert_eq!(
        c.config.initial_temperature_k,
        c.config.exhaust_temperature_k
    );
    for i in (0..c.trace.angle_deg.len()).step_by(11) {
        near(
            c.trace.pressure_pa[i] * c.trace.volume_m3[i],
            c.trace.mass_kg[i] * 287.05 * c.trace.temperature_k[i],
            1e-11,
        );
    }
    near(c.net_work_j, c.gross_work_j + c.pumping_work_j, 1e-12);
}
#[test]
fn returned_cycle_cannot_modify_future_cached_physics() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::default_for(&e);
    let mut c = get_cylinder_cycle(&e, &p, 3300.0, 0.65, None, 1.0).unwrap();
    let original = c.result.trace.pressure_pa[0];
    c.result.trace.pressure_pa[0] = 1.0;
    assert_eq!(
        get_cylinder_cycle(&e, &p, 3300.0, 0.65, None, 1.0)
            .unwrap()
            .trace
            .pressure_pa[0],
        original
    );
}
#[test]
fn cut_points_are_fuel_free_and_pumping_is_not_subtracted_twice() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::default_for(&e);
    for (rpm, throttle) in [(4000.0, 0.0), (e.redline, 1.0)] {
        let a = evaluate_engine(&e, &p, rpm, throttle, 1.0).unwrap();
        assert!(a.fuel_cut);
        assert_eq!(a.fuel_mass_flow_kgs, 0.0);
        assert!(a.torque_nm < 0.0);
        near(
            a.torque_nm,
            a.indicated_torque_nm - a.pumping_torque_nm - a.friction_torque_nm,
            1e-12,
        );
    }
}
#[test]
fn invalid_maps_reject_and_calibration_metadata_and_units_round_trip() {
    let e = EngineConfig::default();
    assert!(PhysicalConfig::from_value(&e, &json!({"veMap":{"schema":"bad"}})).is_err());
    assert!(PhysicalConfig::from_value(&e, &json!({"veMap":null})).is_err());
    let p=PhysicalConfig::from_value(&e,&json!({"fuelLhvMJkg":37.5,"cycleCalibration":{"source":"test","referenceHash":"abc","rpm":3000,"throttle":0.6,"rmseBar":0.3,"method":"bounded-grid","status":"fitted","sparkAdvanceDeg":18,"burnDurationDeg":50,"angleOrigin":"firing-tdc"}})).unwrap();
    let encoded = serde_json::to_value(&p).unwrap();
    assert_eq!(encoded["fuelLhvMJkg"], 37.5);
    assert!(encoded.get("fuelLhvMjkg").is_none());
    assert!(encoded.get("fmepMap").is_none());
    let restored = PhysicalConfig::from_value(&e, &encoded).unwrap();
    assert_eq!(restored.fuel_lhv_mjkg, 37.5);
    assert_eq!(
        restored.cycle_calibration.unwrap().angle_origin.as_deref(),
        Some("firing-tdc")
    );
}
#[test]
fn clutch_impulses_are_passive_in_both_power_directions() {
    let inertia = 0.03;
    let mass = 400.0;
    let tyre: f64 = 0.2;
    let ratio = 36.0;
    let efficiency = 0.65;
    let dt = 1.0 / 240.0;
    for (engine, wheel) in [(500.0, 0.0), (100.0, 20.0)] {
        let impulse = passive_clutch_impulse(
            engine, wheel, ratio, inertia, mass, tyre, efficiency, 1.0, dt,
        );
        let wheel_impulse = transmitted_wheel_torque(impulse, ratio, efficiency);
        let after_engine = engine - impulse / inertia;
        let after_wheel = wheel + wheel_impulse / (mass * tyre.powi(2));
        let before = 0.5 * inertia * engine * engine + 0.5 * mass * tyre.powi(2) * wheel * wheel;
        let after = 0.5 * inertia * after_engine * after_engine
            + 0.5 * mass * tyre.powi(2) * after_wheel * after_wheel;
        assert!(after <= before + 1e-7);
    }
}
#[test]
fn repeated_dynamics_and_reset_are_deterministic_and_share_gas_state() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::default_for(&e);
    let mut a = Powertrain::new(e.clone(), p.clone()).unwrap();
    let mut b = Powertrain::new(e, p).unwrap();
    for i in 0..240 {
        let demand = if i < 160 { 0.7 } else { 0.0 };
        let aa = a.step(1.0 / 240.0, demand, 0.0, 1).unwrap();
        let bb = b.step(1.0 / 240.0, demand, 0.0, 1).unwrap();
        assert_eq!(
            serde_json::to_value(&aa).unwrap(),
            serde_json::to_value(bb).unwrap()
        );
        assert_eq!(aa.physical.boost_bar, 0.0);
        near(
            aa.physical.intake_pressure_bar,
            aa.gas_path.intake.pressure_pa / 1e5,
            1e-14,
        );
        near(
            aa.physical.exhaust_temperature_k,
            aa.gas_path.exhaust.temperature_k,
            1e-14,
        );
        assert!(
            aa.rpm.is_finite()
                && aa.speed_ms.is_finite()
                && aa.thermal.energy_residual_j.is_finite()
        );
    }
    let before = a.reset(None, None).unwrap();
    b.reset(None, None).unwrap();
    assert_eq!(before.speed_ms, 0.0);
    assert_eq!(before.physical.cycle_index, 0.0);
    assert_eq!(
        serde_json::to_value(a.step(0.02, 0.6, 0.0, 0).unwrap()).unwrap(),
        serde_json::to_value(b.step(0.02, 0.6, 0.0, 0).unwrap()).unwrap()
    );
}
#[test]
fn mass_and_inertia_change_the_appropriate_dynamic_response() {
    let e = EngineConfig::default();
    let low = PhysicalConfig::from_value(&e, &json!({"engineInertiaKgM2":0.05})).unwrap();
    let high = PhysicalConfig::from_value(&e, &json!({"engineInertiaKgM2":0.8})).unwrap();
    let mut light = Powertrain::new(e.clone(), low).unwrap();
    let mut heavy = Powertrain::new(e, high).unwrap();
    for _ in 0..120 {
        light.step(1.0 / 240.0, 0.7, 0.0, 0).unwrap();
        heavy.step(1.0 / 240.0, 0.7, 0.0, 0).unwrap();
    }
    assert!(light.get_state().rpm > heavy.get_state().rpm);
}

#[test]
fn classic_v12_idle_internal_resolution_is_independent_of_plot_sampling() {
    use carlab_engine_lab::cylinder_cycle::solve_cylinder_cycle;
    let e=EngineConfig::from_value(&json!({"cylinders":12,"layout":"v","bankAngle":60,"displacement":5,"compression":9.6,"idleRpm":760,"redline":7000,"headerLength":0.9,"exhaustLength":2.65,"pipeDiameter":63,"inertia":0.6,"roughness":0.5,"temperature":500,"seed":501276})).unwrap();
    let p = PhysicalConfig::default_for(&e);
    let fitted = get_cylinder_cycle(&e, &p, e.idle_rpm, 0.2, None, 1.0).unwrap();
    let mut config = fitted.config.clone();
    config.step_deg = 2.0;
    let coarse = solve_cylinder_cycle(&config).unwrap();
    config.step_deg = 1.0;
    let dense = solve_cylinder_cycle(&config).unwrap();
    config.step_deg = 0.5;
    let finer = solve_cylinder_cycle(&config).unwrap();
    assert!(coarse.steps >= 2880);
    assert_eq!(coarse.steps, dense.steps);
    near(coarse.net_work_j, dense.net_work_j, 1e-12);
    near(coarse.peak_pressure_pa, dense.peak_pressure_pa, 1e-12);
    near(
        coarse.exhaust_temperature_k,
        dense.exhaust_temperature_k,
        1e-12,
    );
    near(coarse.exhaust_mass_kg, dense.exhaust_mass_kg, 1e-12);
    assert!(finer.steps >= coarse.steps * 2);
    assert!(finer.net_work_j > 0.0 && finer.exhaust_temperature_k.is_finite());
    assert!((finer.net_work_j - coarse.net_work_j).abs() / finer.net_work_j.abs() < 0.002);
    assert!(
        (finer.peak_pressure_pa - coarse.peak_pressure_pa).abs() / finer.peak_pressure_pa < 0.002
    );
    assert!((finer.exhaust_temperature_k - coarse.exhaust_temperature_k).abs() < 15.0);
}

#[test]
fn explicit_zero_combustion_retains_actual_fuel_without_released_heat() {
    use carlab_engine_lab::cylinder_cycle::{CylinderCycleConfig, solve_cylinder_cycle};
    let c =
        CylinderCycleConfig::from_value(&json!({"fuelMassKg":0.00004,"combustionEfficiency":0.0}))
            .unwrap();
    let result = solve_cylinder_cycle(&c).unwrap();
    assert_eq!(result.fuel_mass_kg, 0.00004);
    assert!(result.fuel_energy_j > 0.0);
    assert_eq!(result.released_heat_j, 0.0);
    assert!(result.energy_balance_residual_j.abs() < 1e-7);
}
#[test]
fn rich_oxygen_cap_uses_actual_ivc_charge_without_erasing_unburned_fuel() {
    use carlab_engine_lab::cylinder_cycle::{CylinderCycleConfig, solve_cylinder_cycle};
    let config =
        CylinderCycleConfig::from_value(&json!({"fuelMassKg":0.0002,"oxygenLimitAfr":14.7}))
            .unwrap();
    let a = solve_cylinder_cycle(&config).unwrap();
    let mut config = config.clone();
    config.fuel_mass_kg = Some(0.0004);
    let b = solve_cylinder_cycle(&config).unwrap();
    near(a.net_work_j, b.net_work_j, 1e-12);
    near(a.released_heat_j, b.released_heat_j, 1e-12);
    near(a.peak_pressure_pa, b.peak_pressure_pa, 1e-12);
    assert_eq!(b.fuel_mass_kg, 2.0 * a.fuel_mass_kg);
    near(b.fuel_energy_j, 2.0 * a.fuel_energy_j, 1e-12);
    near(
        a.oxygen_limited_fuel_mass_kg.unwrap(),
        a.fresh_charge_mass_kg / 14.7,
        1e-12,
    );
    assert!(b.oxygen_unburned_fuel_mass_kg.unwrap() > a.oxygen_unburned_fuel_mass_kg.unwrap());
    assert!(b.energy_balance_residual_j.abs() < 1e-7);
}
#[test]
fn efi_disabled_preserves_legacy_physics_and_optional_state_shape() {
    let e = EngineConfig::default();
    let default = PhysicalConfig::default_for(&e);
    let explicit = PhysicalConfig::from_value(&e, &json!({"ecu":{"enabled":false}})).unwrap();
    assert!(!default.ecu.enabled);
    let a = evaluate_engine(&e, &default, 3200.0, 0.7, 1.0).unwrap();
    let b = evaluate_engine(&e, &explicit, 3200.0, 0.7, 1.0).unwrap();
    assert_eq!(
        serde_json::to_value(a).unwrap(),
        serde_json::to_value(b).unwrap()
    );
    let state = Powertrain::new(e, default).unwrap().get_state();
    assert!(state.ecu.is_none());
    assert!(state.ecu_coupling.is_none());
    assert!(serde_json::to_value(state).unwrap().get("ecu").is_none());
}
#[test]
fn efi_delivered_dose_and_spark_drive_pressure_without_refitting_breathing() {
    use carlab_engine_lab::powertrain::evaluate_controlled_point;
    let e = EngineConfig::default();
    let p = PhysicalConfig::from_value(
        &e,
        &json!({"ecu":{"enabled":true,"feedback":{"enabled":false}}}),
    )
    .unwrap();
    let lean = evaluate_controlled_point(&e, &p, 3000.0, 0.7, Some(1.3), Some(18.0)).unwrap();
    let normal = evaluate_controlled_point(&e, &p, 3000.0, 0.7, Some(1.0), Some(18.0)).unwrap();
    let retarded = evaluate_controlled_point(&e, &p, 3000.0, 0.7, Some(1.0), Some(0.0)).unwrap();
    assert!(normal.fuel_mass_flow_kgs > lean.fuel_mass_flow_kgs);
    assert!(normal.torque_nm > lean.torque_nm);
    assert!((normal.torque_nm - retarded.torque_nm).abs() > 0.01);
    for point in [&lean, &normal, &retarded] {
        let summary = point.ecu.as_ref().unwrap();
        assert_eq!(summary.coupling_mode, "steady-open-loop");
        assert!(!summary.state.feedback_active);
        near(
            point.fuel_mass_flow_kgs,
            summary.state.delivered_fuel_mass_flow_kgs,
            1e-12,
        );
        near(
            point.fuel_power_kw,
            point.fuel_mass_flow_kgs * summary.state.fuel_lhv_jkg / 1000.0,
            1e-12,
        );
        assert!(summary.fuel_mass_relative_mismatch < 1e-12);
    }
    let a = get_cylinder_cycle(&e, &p, 3000.0, 0.7, None, 1.0).unwrap();
    let mut legacy_knob = p.clone();
    legacy_knob.air_fuel_ratio = 8.0;
    legacy_knob.fuel_lhv_mjkg = 21.0;
    let ignored = evaluate_engine(&e, &legacy_knob, 3000.0, 0.7, 1.0).unwrap();
    let baseline = evaluate_engine(&e, &p, 3000.0, 0.7, 1.0).unwrap();
    near(ignored.torque_nm, baseline.torque_nm, 1e-12);
    near(
        ignored.fuel_mass_flow_kgs,
        baseline.fuel_mass_flow_kgs,
        1e-12,
    );

    let mut richer = p.clone();
    for row in &mut richer.ecu.fuel_correction_map.values {
        row.fill(2.0);
    }
    let b = get_cylinder_cycle(&e, &richer, 3000.0, 0.7, None, 1.0).unwrap();
    assert_eq!(a.config.intake_valve_lift_m, b.config.intake_valve_lift_m);
    assert!(b.fuel_mass_kg > a.fuel_mass_kg);
    assert!(b.oxygen_unburned_fuel_mass_kg.unwrap() > 0.0);
    assert!(
        b.released_heat_j
            <= b.fresh_charge_mass_kg / b.config.oxygen_limit_afr.unwrap()
                * b.config.fuel_lhv_jkg
                * b.config.combustion_efficiency
                + 1e-7
    );
}
#[test]
fn efi_honors_injector_capacity_and_flags_unsupported_supply_instead_of_fake_torque() {
    let e = EngineConfig::default();
    let p=PhysicalConfig::from_value(&e,&json!({"ecu":{"enabled":true,"injector":{"referenceFlowCcMin":1.0},"feedback":{"enabled":false}}})).unwrap();
    let estimate = evaluate_engine(&e, &p, 5000.0, 1.0, 1.0).unwrap();
    let summary = estimate.ecu.as_ref().unwrap();
    assert!(summary.state.actuator_saturated);
    assert!(!summary.coupling_quantitatively_valid);
    assert!(summary.state.injected_fuel_mass_flow_kgs < summary.state.requested_fuel_mass_flow_kgs);
    near(
        estimate.fuel_mass_flow_kgs,
        summary.state.delivered_fuel_mass_flow_kgs,
        1e-12,
    );
    let legacy = evaluate_engine(&e, &PhysicalConfig::default_for(&e), 5000.0, 1.0, 1.0).unwrap();
    assert!(estimate.torque_nm < legacy.torque_nm);
}
#[test]
fn efi_dynamic_film_and_combustion_cuts_are_distinct_and_audio_uses_delivery() {
    let e = EngineConfig::default();
    let p = PhysicalConfig::from_value(
        &e,
        &json!({"ecu":{"enabled":true,"feedback":{"enabled":false}}}),
    )
    .unwrap();
    let mut a = Powertrain::new(e.clone(), p.clone()).unwrap();
    let mut b = Powertrain::new(e.clone(), p.clone()).unwrap();
    a.reset(Some(3000.0), None).unwrap();
    b.reset(Some(3000.0), None).unwrap();
    for _ in 0..80 {
        let aa = a.step(1.0 / 240.0, 0.6, 0.0, 0).unwrap();
        let bb = b.step(1.0 / 240.0, 0.6, 0.0, 0).unwrap();
        assert_eq!(
            serde_json::to_value(aa).unwrap(),
            serde_json::to_value(bb).unwrap()
        );
    }
    let cut = a.step(1.0 / 240.0, 0.0, 0.0, 0).unwrap();
    let state = cut.ecu.as_ref().unwrap();
    assert!(state.injector_cut);
    assert!(!state.combustion_cut);
    assert_eq!(state.injected_fuel_mass_flow_kgs, 0.0);
    assert!(state.delivered_fuel_mass_flow_kgs > 0.0);
    assert!(!cut.physical.fuel_cut);
    assert!(cut.physical.cycle_energy_scale > 0.0);
    assert!(state.fuel_mass_residual_kg.abs() < 1e-10);
    a.reset(Some(e.redline), None).unwrap();
    let ignition_cut = a.step(0.0001, 0.6, 0.0, 0).unwrap();
    let ecu = ignition_cut.ecu.as_ref().unwrap();
    assert!(ecu.combustion_cut);
    assert!(!ecu.injector_cut);
    assert!(ecu.delivered_fuel_mass_flow_kgs > 0.0);
    assert!(ecu.unburned_fuel_mass_flow_kgs > 0.0);
    assert!(ignition_cut.physical.fuel_cut);
    assert_eq!(ignition_cut.physical.cycle_energy_scale, 0.0);
    assert!(
        a.get_operating_estimate()
            .unwrap()
            .ecu
            .unwrap()
            .cycle_released_heat_j
            == 0.0
    );
}

#[test]
fn prescribed_single_main_injection_cannot_release_undelivered_fuel_heat() {
    use carlab_engine_lab::cylinder_cycle::{CylinderCycleConfig, solve_cylinder_cycle};
    let c=CylinderCycleConfig::from_value(&json!({"fuelMassKg":0.00003,"combustionStartDeg":350,"burnDurationDeg":20,"fuelDeliveryStartDeg":345,"fuelDeliveryDurationDeg":80})).unwrap();
    let result = solve_cylinder_cycle(&c).unwrap();
    for (&angle, &heat) in result
        .trace
        .angle_deg
        .iter()
        .zip(&result.trace.heat_release_j)
    {
        if angle <= 345.0 {
            assert_eq!(heat, 0.0);
        }
        let fraction = ((angle - 345.0) / 80.0).clamp(0.0, 1.0);
        assert!(heat <= result.fuel_energy_j * c.combustion_efficiency * fraction + 1e-8);
    }
    near(result.ca50_deg, 385.0, 1e-12);
    near(result.ca90_deg, 417.0, 1e-12);
    assert!(result.energy_balance_residual_j.abs() < 1e-7);
}
#[test]
fn diesel_quantity_and_soi_control_pressure_with_separate_air_valve_and_cylinder_injector_boundary()
{
    use carlab_engine_lab::powertrain::{
        ControlledPointOverrides, cycle_config_for, evaluate_controlled_point_with_overrides,
    };
    let e = EngineConfig::from_value(&json!({"compression":16.0})).unwrap();
    let p = PhysicalConfig::from_value(
        &e,
        &json!({"ecu":{"enabled":true,"combustionMode":"directInjectionDiesel"}}),
    )
    .unwrap();
    let ca = cycle_config_for(&e, &p, 3000.0, 0.2, None, 1.0).unwrap();
    let cb = cycle_config_for(&e, &p, 3000.0, 0.8, None, 1.0).unwrap();
    assert_eq!(ca.intake_pressure_pa, cb.intake_pressure_pa);
    let low = evaluate_controlled_point_with_overrides(
        &e,
        &p,
        3000.0,
        0.4,
        &ControlledPointOverrides {
            diesel_quantity_mg_per_cylinder: Some(15.0),
            injection_start_deg_btdc: Some(12.0),
            ..Default::default()
        },
    )
    .unwrap();
    let high = evaluate_controlled_point_with_overrides(
        &e,
        &p,
        3000.0,
        0.4,
        &ControlledPointOverrides {
            diesel_quantity_mg_per_cylinder: Some(25.0),
            injection_start_deg_btdc: Some(12.0),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(high.fuel_mass_flow_kgs > low.fuel_mass_flow_kgs);
    assert!(high.torque_nm > low.torque_nm);
    let summary = low.ecu.as_ref().unwrap();
    near(
        summary.state.requested_fuel_mg_per_cylinder_cycle,
        15.0,
        1e-12,
    );
    assert_eq!(summary.state.spark_advance_deg, 0.0);
    assert_eq!(low.otto_efficiency, 0.0);
    assert!(
        summary.injection_pressure_reference_pa.unwrap() > low.manifold_pressure_bar * 1e5 * 3.0
    );
    assert!(summary.cycle_injection_pressure_pa.unwrap() > 1e5);
    assert!(
        summary
            .injection_pressure_relative_mismatch
            .unwrap()
            .is_finite()
    );
    assert!(summary.state.effective_injection_duration_deg.unwrap() > 0.0);
    let mut ignored = p.clone();
    ignored.spark_advance_deg = -10.0;
    let b = evaluate_controlled_point_with_overrides(
        &e,
        &ignored,
        3000.0,
        0.4,
        &ControlledPointOverrides {
            diesel_quantity_mg_per_cylinder: Some(15.0),
            injection_start_deg_btdc: Some(12.0),
            ..Default::default()
        },
    )
    .unwrap();
    near(b.torque_nm, low.torque_nm, 1e-12);
    assert!(
        carlab_engine_lab::powertrain::evaluate_controlled_point(
            &e,
            &p,
            3000.0,
            0.4,
            Some(1.0),
            None
        )
        .is_err()
    );
}
#[test]
fn rejected_live_film_mode_switch_preserves_entire_plant_then_explicit_new_model_resets() {
    use carlab_engine_lab::ecu::CombustionMode;
    let e = EngineConfig::default();
    let p = PhysicalConfig::from_value(
        &e,
        &json!({"ecu":{"enabled":true,"feedback":{"enabled":false}}}),
    )
    .unwrap();
    let mut a = Powertrain::new(e.clone(), p.clone()).unwrap();
    let mut b = Powertrain::new(e.clone(), p.clone()).unwrap();
    a.reset(Some(3000.0), Some(2.0)).unwrap();
    b.reset(Some(3000.0), Some(2.0)).unwrap();
    for _ in 0..30 {
        a.step(1.0 / 240.0, 0.5, 0.0, 0).unwrap();
        b.step(1.0 / 240.0, 0.5, 0.0, 0).unwrap();
    }
    assert!(a.get_state().ecu.unwrap().wall_film_mass_kg > 1e-12);
    let mut ci = p.clone();
    ci.ecu.combustion_mode = CombustionMode::DirectInjectionDiesel;
    ci.intake_volume_l = 9.0;
    ci.thermal.initial_wall_temperature_k = 600.0;
    let before = serde_json::to_value(a.get_state()).unwrap();
    assert!(a.set_config(e.clone(), ci.clone()).is_err());
    assert_eq!(before, serde_json::to_value(a.get_state()).unwrap());
    assert_eq!(
        serde_json::to_value(a.step(1.0 / 240.0, 0.5, 0.0, 0).unwrap()).unwrap(),
        serde_json::to_value(b.step(1.0 / 240.0, 0.5, 0.0, 0).unwrap()).unwrap()
    );
    let fresh = Powertrain::new(e, ci).unwrap().get_state();
    assert_eq!(fresh.speed_ms, 0.0);
    assert_eq!(fresh.ecu.as_ref().unwrap().wall_film_mass_kg, 0.0);
    assert_eq!(
        fresh.ecu.unwrap().combustion_mode,
        CombustionMode::DirectInjectionDiesel
    );
}
