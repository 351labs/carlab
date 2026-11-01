//! Model-3 physics: NASA-7 fixed-composition properties, Woschni wall transfer,
//! spark-to-SOC semantics, cam phasing, valve-geometry airflow and static boundaries.
use carlab_engine_lab::config::EngineConfig;
use carlab_engine_lab::cylinder_cycle::{
    CylinderCycleConfig, solve_cylinder_cycle, spark_to_soc_from_ca10_delay, woschni_coefficient,
};
use carlab_engine_lab::gas_properties::{Blend, FuelChemistry, Mixture, T_MAX, T_MIN, wgs_constant};
use carlab_engine_lab::powertrain::{
    AirflowModel, GasPathBoundary, PhysicalConfig, cycle_config_for, evaluate_engine, evaluate_engine_at_boundary,
    get_cylinder_cycle,
};
use serde_json::json;

fn near(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() <= tol * a.abs().max(b.abs()).max(1.0), "{a} != {b}");
}
fn cycle(v: serde_json::Value) -> CylinderCycleConfig {
    CylinderCycleConfig::from_value(&v).unwrap()
}
const GASOLINE: FuelChemistry = FuelChemistry { hydrogen_carbon: 1.83, oxygen_carbon: 0.0 };

#[test]
fn nasa_air_and_products_have_textbook_magnitudes_and_coherent_u_h_cp() {
    let air = Mixture::air();
    near(air.gas_r, 287.05, 2e-4); // 1976 standard dry air
    near(air.cp(300.0), 1005.0, 3e-3);
    near(air.cp(300.0) / (air.cp(300.0) - air.gas_r), 1.40, 2e-3);
    near(GASOLINE.stoich_afr(), 14.54, 3e-3);
    let burned = GASOLINE.products(1.0, 42.887e6).mixture;
    let g = |t: f64| burned.cp(t) / (burned.cp(t) - burned.gas_r);
    assert!(g(2200.0) > 1.2 && g(2200.0) < 1.27, "hot products gamma {}", g(2200.0));
    for m in [&air, &burned] {
        assert_eq!(m.h(298.15), 0.0);
        for t in [250.0, 700.0, 999.9, 1000.1, 2500.0, 5000.0] {
            // Flow work: h - u = R T exactly, or valve streams gain/lose energy.
            near(m.h(t) - m.u(t), m.gas_r * t, 1e-12);
            let cv = (m.u(t + 0.01) - m.u(t - 0.01)) / 0.02;
            near(cv, m.cp(t) - m.gas_r, 1e-5);
        }
    }
}

#[test]
fn temperature_inversion_round_trips_and_refuses_extrapolation() {
    let (air, burned) = (Mixture::air(), GASOLINE.products(0.95, 42.887e6).mixture);
    for fresh in [0.0, 0.3, 1.0] {
        let b = Blend { air: &air, burned: &burned, fresh };
        for t in [T_MIN, 230.0, 298.15, 999.999, 1000.0, 1800.0, 3200.0, T_MAX] {
            near(b.temperature(b.u(t)).unwrap(), t, 1e-9);
        }
        assert!(b.temperature(b.u(T_MIN) - 1.0).is_none());
        assert!(b.temperature(b.u(T_MAX) + 1.0).is_none());
        assert!(b.temperature(f64::NAN).is_none());
    }
}

#[test]
fn rich_products_hold_back_co_h2_heating_value_and_lean_release_all() {
    // Cross-check only: textbook water-gas-shift K near 3.5 around 1700-1750 K.
    let k = wgs_constant(1700.0);
    assert!(k > 3.0 && k < 4.2, "K(1700)={k}");
    assert_eq!(GASOLINE.products(0.8, 42.887e6).released_fraction, 1.0);
    assert_eq!(GASOLINE.products(1.0, 42.887e6).released_fraction, 1.0);
    let rich = GASOLINE.products(1.0 / 0.845, 42.887e6).released_fraction;
    // Never above the stoichiometric oxygen cap (1/phi) used by the EFI path.
    assert!(rich < 0.845 && rich > 0.7, "{rich}");
}

#[test]
fn nasa_cycle_closes_mass_and_energy_and_is_reversible_when_sealed() {
    let sealed_at = |t: f64| solve_cylinder_cycle(&cycle(json!({"propertyModel":"nasa7-fixed-composition","intakeValveLiftM":0,"exhaustValveLiftM":0,"fuelMassKg":0,"heatTransferWm2K":0,"initialPressurePa":1e5,"initialTemperatureK":t,"settlingCycles":0,"stepDeg":1})));
    // Expanding a sealed 315 K charge leaves the 200 K coefficient domain: refused.
    assert!(sealed_at(315.0).is_err());
    let sealed = sealed_at(800.0).unwrap();
    assert!(sealed.net_work_j.abs() < 0.01, "{}", sealed.net_work_j);
    assert!(sealed.energy_balance_residual_j.abs() < 1e-9);
    assert_eq!(sealed.status, "uncalibrated-fixed-composition");
    for model in ["air-standard", "nasa7-fixed-composition"] {
        for ht in ["constant", "woschni"] {
            let r = solve_cylinder_cycle(&cycle(json!({"propertyModel":model,"heatTransferModel":ht}))).unwrap();
            assert!(r.mass_balance_residual_kg.abs() < 1e-15, "{model}/{ht}");
            assert!(r.energy_balance_residual_j.abs() < 1e-8, "{model}/{ht} {}", r.energy_balance_residual_j);
            assert!(r.periodic_mass_relative_error < 0.02 && r.periodic_energy_relative_error < 0.02);
            if model == "nasa7-fixed-composition" {
                near(r.burned_gas_equivalence_ratio.unwrap(), GASOLINE_DEFAULT_STOICH / 14.7, 1e-9);
                for i in (0..r.trace.angle_deg.len()).step_by(17) {
                    assert!(r.trace.temperature_k[i] >= 200.0 && r.trace.temperature_k[i] <= 6000.0);
                }
            }
        }
    }
}
// Default kernel fuel is CH1.85 with no oxygen.
const GASOLINE_DEFAULT_STOICH: f64 = {
    // (1 + y/4) * air mass per mol O2 / fuel molar mass, y = 1.85
    (1.0 + 1.85 / 4.0) * (0.78084 * 0.0280134 + 0.209476 * 0.0319988 + 0.00934 * 0.039948 + 0.000314 * 0.0440095) / 0.209476
        / (0.012011 + 1.85 * 0.001008)
};

#[test]
fn variable_properties_and_woschni_lower_work_for_the_same_fired_charge() {
    let base = json!({"rpm":2000,"intakePressurePa":80000,"exhaustPressurePa":102000});
    let solve = |extra: serde_json::Value| {
        let mut v = base.clone();
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        solve_cylinder_cycle(&cycle(v)).unwrap()
    };
    let legacy = solve(json!({}));
    let nasa = solve(json!({"propertyModel":"nasa7-fixed-composition"}));
    let both = solve(json!({"propertyModel":"nasa7-fixed-composition","heatTransferModel":"woschni"}));
    let eff = |r: &carlab_engine_lab::cylinder_cycle::CylinderCycleResult| r.gross_work_j / r.fuel_energy_j;
    // Hot products have lower gamma than 1.33 and Woschni h exceeds 180 W/m2K in combustion.
    assert!(eff(&nasa) < eff(&legacy), "{} {}", eff(&nasa), eff(&legacy));
    assert!(both.wall_heat_loss_j > nasa.wall_heat_loss_j);
    assert!(eff(&both) < eff(&nasa));
    assert!(both.peak_heat_transfer_wm2_k > 180.0 && both.peak_heat_transfer_wm2_k < 10000.0);
    let off = solve(json!({"heatTransferModel":"woschni","heatTransferMultiplier":0}));
    assert_eq!(off.wall_heat_loss_j, 0.0);
}

#[test]
fn woschni_uses_kpa_and_its_published_exponents() {
    // Kirkpatrick/CSU example: b=0.1 m, P=500 kPa, T=1000 K, U=10 m/s.
    near(woschni_coefficient(0.1, 500e3, 1000.0, 10.0), 105.2916, 1e-5);
    near(woschni_coefficient(0.1, 1000e3, 1000.0, 10.0) / woschni_coefficient(0.1, 500e3, 1000.0, 10.0), 2f64.powf(0.8), 1e-12);
    near(woschni_coefficient(0.1, 500e3, 2000.0, 10.0) / woschni_coefficient(0.1, 500e3, 1000.0, 10.0), 2f64.powf(-0.55), 1e-12);
}

#[test]
fn spark_to_soc_offset_shifts_phasing_one_to_one_and_converts_ca10_delays() {
    let base = solve_cylinder_cycle(&cycle(json!({"sparkAdvanceDeg":25}))).unwrap();
    let late = solve_cylinder_cycle(&cycle(json!({"sparkAdvanceDeg":25,"sparkToSocDeg":7}))).unwrap();
    near(late.soc_deg - base.soc_deg, 7.0, 1e-12);
    near(late.ca50_deg - base.ca50_deg, 7.0, 1e-9);
    near(base.soc_deg, 335.0, 1e-12);
    // A requested spark-to-CA10 delay lands CA10 exactly that far after the spark.
    let offset = spark_to_soc_from_ca10_delay(18.0, 50.0, 6.9, 2.0);
    assert!(offset < 18.0);
    let r = solve_cylinder_cycle(&cycle(json!({"sparkAdvanceDeg":25,"sparkToSocDeg":offset}))).unwrap();
    near(r.ca10_deg, 335.0 + 18.0, 1e-9);
    // Diesel/explicit SOC is never moved by the SI offset.
    let ci = solve_cylinder_cycle(&cycle(json!({"combustionStartDeg":365,"sparkToSocDeg":9}))).unwrap();
    near(ci.soc_deg, 365.0, 1e-12);
}

fn mazda_like() -> (EngineConfig, serde_json::Value) {
    let e = EngineConfig::from_value(&json!({"cylinders":4,"layout":"inline","displacement":1.998,"compression":13,"idleRpm":850,"redline":6800})).unwrap();
    (e, json!({"boreStrokeRatio":0.9155701754385964}))
}

#[test]
fn cam_retard_moves_opening_and_closing_together_and_reports_clamping() {
    let (e, v) = mazda_like();
    let mut v2 = v.clone();
    v2["intakeCamRetardDeg"] = json!(40);
    v2["exhaustCamRetardDeg"] = json!(15);
    let base = PhysicalConfig::from_value(&e, &v).unwrap();
    let shifted = PhysicalConfig::from_value(&e, &v2).unwrap();
    let (a, b) = (
        cycle_config_for(&e, &base, 2000.0, 0.5, None, 1.0).unwrap(),
        cycle_config_for(&e, &shifted, 2000.0, 0.5, None, 1.0).unwrap(),
    );
    near(b.intake_open_deg - a.intake_open_deg, 40.0, 1e-12);
    near(b.intake_close_deg - a.intake_close_deg, 40.0, 1e-12);
    near(b.exhaust_open_deg - a.exhaust_open_deg, 15.0, 1e-12);
    near(b.exhaust_close_deg - a.exhaust_close_deg, 15.0, 1e-12);
    let mut v3 = v.clone();
    v3["intakeCloseDeg"] = json!(280);
    v3["intakeCamRetardDeg"] = json!(80);
    v3["airflowModel"] = json!("valve-geometry");
    let clamped = PhysicalConfig::from_value(&e, &v3).unwrap();
    let c = get_cylinder_cycle(&e, &clamped, 2000.0, 0.5, None, 1.0).unwrap();
    assert!(c.warnings.iter().any(|w| w.contains("Cam-shifted valve event")));
}

#[test]
fn valve_geometry_reports_untargeted_ve_and_lift_fit_logs_each_trial() {
    let (e, v) = mazda_like();
    let mut geometric = v.clone();
    geometric["airflowModel"] = json!("valve-geometry");
    geometric["intakeCamRetardDeg"] = json!(60);
    let g = get_cylinder_cycle(&e, &PhysicalConfig::from_value(&e, &geometric).unwrap(), 2000.0, 0.5, None, 1.0).unwrap();
    assert_eq!(g.calibration.iterations, 1);
    assert_eq!(g.calibration.trials.len(), 1);
    assert!(g.calibration.miss_classification.is_none());
    assert!(!g.warnings.iter().any(|w| w.contains("VE target")));
    let fitted = get_cylinder_cycle(&e, &PhysicalConfig::from_value(&e, &v).unwrap(), 2000.0, 0.5, None, 1.0).unwrap();
    assert_eq!(fitted.calibration.trials.len(), fitted.calibration.iterations);
    assert_eq!(fitted.calibration.trials.last().unwrap().actual_ve, fitted.calibration.actual_ve);
    if fitted.calibration.ve_residual.abs() > 0.03 {
        assert!(fitted.calibration.miss_classification.is_some());
    }
    // Late intake closing pushes charge back: less trapped air than the base events.
    assert!(g.calibration.actual_ve < fitted.calibration.trials[0].actual_ve);
}

#[test]
fn static_boundary_evaluation_uses_rust_brake_equations_and_net_inlet_flow() {
    let (e, v) = mazda_like();
    let mut physical = v.clone();
    physical["airflowModel"] = json!("valve-geometry");
    physical["propertyModel"] = json!("nasa7-fixed-composition");
    physical["heatTransferModel"] = json!("woschni");
    let p = PhysicalConfig::from_value(&e, &physical).unwrap();
    let boundary = GasPathBoundary {
        intake_pressure_pa: 89447.0,
        intake_temperature_k: 301.26,
        exhaust_pressure_pa: 98216.0,
        exhaust_temperature_k: 899.3,
    };
    let point = evaluate_engine_at_boundary(&e, &p, 1497.0, 1.0, 1.0, Some(&boundary)).unwrap();
    let c = get_cylinder_cycle(&e, &p, 1497.0, 1.0, Some(&boundary), 1.0).unwrap();
    assert_eq!(c.config.intake_pressure_pa, 89447.0);
    near(point.torque_nm, c.net_work_j * 4.0 / (4.0 * std::f64::consts::PI) - point.friction_torque_nm, 1e-12);
    let frequency = 4.0 * 1497.0 / 120.0;
    near(point.net_inlet_air_mass_flow_kgs, (c.intake_mass_in_kg - c.intake_reverse_mass_kg) * frequency, 1e-12);
    near(point.air_mass_flow_kgs, c.fresh_charge_mass_kg * frequency, 1e-12);
    assert_eq!(point.cycle.valve_events_deg[1], c.config.intake_close_deg);
    // Without a boundary the static API is the ordinary steady evaluation.
    let free = evaluate_engine_at_boundary(&e, &p, 3000.0, 0.7, 1.0, None).unwrap();
    assert_eq!(serde_json::to_string(&free).unwrap(), serde_json::to_string(&evaluate_engine(&e, &p, 3000.0, 0.7, 1.0).unwrap()).unwrap());
}

#[test]
fn unknown_model_names_are_rejected_rather_than_silently_defaulted() {
    assert!(CylinderCycleConfig::from_value(&json!({"propertyModel":"ideal"})).is_err());
    assert!(CylinderCycleConfig::from_value(&json!({"heatTransferModel":"annand"})).is_err());
    let e = EngineConfig::default();
    assert!(PhysicalConfig::from_value(&e, &json!({"airflowModel":"magic"})).is_err());
}

#[test]
fn cycle_cache_distinguishes_airflow_model_at_identical_cycle_config() {
    let (e, v) = mazda_like();
    let fit = PhysicalConfig::from_value(&e, &v).unwrap();
    let mut g = v.clone();
    g["airflowModel"] = json!("valve-geometry");
    let geometric = PhysicalConfig::from_value(&e, &g).unwrap();
    let a = get_cylinder_cycle(&e, &fit, 2000.0, 0.5, None, 1.0).unwrap();
    let b = get_cylinder_cycle(&e, &geometric, 2000.0, 0.5, None, 1.0).unwrap();
    assert_eq!(a.calibration.airflow_model, AirflowModel::VeMapFit);
    assert_eq!(b.calibration.airflow_model, AirflowModel::ValveGeometry);
    assert_eq!(b.calibration.iterations, 1);
}

#[test]
fn nasa_adiabatic_throttled_intake_is_not_colder_than_its_fresh_air() {
    // Regression: u = h - R(T - 298.15) dropped the flow work and cooled the charge to ~239 K.
    let (e, v) = mazda_like();
    let mut n = v.clone();
    n["propertyModel"] = json!("nasa7-fixed-composition");
    n["heatTransferWm2K"] = json!(0.0);
    n["airflowModel"] = json!("valve-geometry");
    let p = PhysicalConfig::from_value(&e, &n).unwrap();
    let boundary = GasPathBoundary {
        intake_pressure_pa: 54109.0,
        intake_temperature_k: 302.08,
        exhaust_pressure_pa: 95713.0,
        exhaust_temperature_k: 861.0,
    };
    let c = get_cylinder_cycle(&e, &p, 1999.0, 1.0, Some(&boundary), 0.0).unwrap();
    let bdc = c.trace.angle_deg.iter().position(|a| *a >= 180.0).unwrap();
    assert!(c.trace.temperature_k[bdc] > boundary.intake_temperature_k, "T at BDC {}", c.trace.temperature_k[bdc]);
    assert!(c.calibration.actual_ve < 1.0, "throttled NA VE {}", c.calibration.actual_ve);
}
