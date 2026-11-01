use carlab_engine_lab::materials::{
    MechanicalCycleInput, normalize_material_screen_config, parse_material_card, screen_material,
};
use serde_json::{Value, json};

fn near(a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() <= tolerance * b.abs().max(1.0), "{a} != {b}");
}
fn card() -> Value {
    json!({"schema":1,"name":"Fictitious test material", "provenance":{"kind":"assumed","source":"Synthetic unit-test fixture, not an alloy measurement","conditions":"Nominal axial stress only"},"allowableStressMPa":[{"temperatureK":293.15,"value":100},{"temperatureK":393.15,"value":80}]})
}
fn static_cycle() -> MechanicalCycleInput {
    MechanicalCycleInput {
        angle_deg: vec![0.0, 360.0, 720.0],
        pressure_pa: vec![1_101_325.0; 3],
        bore_m: 0.1,
        stroke_m: 0.1,
        rod_length_m: 0.3,
        reciprocating_mass_kg: 0.5,
        rpm: 0.0,
    }
}
fn inertia_cycle() -> MechanicalCycleInput {
    MechanicalCycleInput {
        angle_deg: vec![0.0, 180.0, 360.0, 540.0, 720.0],
        pressure_pa: vec![101_325.0; 5],
        rpm: 3000.0,
        ..static_cycle()
    }
}

#[test]
fn strict_material_boundary_clones_and_rejects_missing_or_malformed_evidence() {
    let mut input = card();
    let parsed = parse_material_card(&input).unwrap();
    input["allowableStressMPa"][0]["value"] = json!(1);
    assert_eq!(parsed.allowable_stress_mpa[0].value, 100.0);
    let mut invalid = card();
    invalid["provenance"] = json!({"kind":"measured","source":""});
    assert!(parse_material_card(&invalid).is_err());
    for points in [
        json!([{"temperatureK":300,"value":null}]),
        json!([{"temperatureK":300,"value":1},{"temperatureK":300,"value":2}]),
        json!([null, null]),
    ] {
        let mut invalid = card();
        invalid["allowableStressMPa"] = points;
        assert!(parse_material_card(&invalid).is_err());
    }
    assert!(
        normalize_material_screen_config(&Value::Null)
            .unwrap()
            .material
            .is_none()
    );
}

#[test]
fn nominal_stress_uses_pressure_area_force_units_without_inventing_resistance() {
    let config = normalize_material_screen_config(
        &json!({"netSectionMm2":100,"componentTemperatureK":343.15}),
    )
    .unwrap();
    let result = screen_material(&static_cycle(), &config).unwrap();
    near(
        result.trace.gas_force_n[0],
        1e6 * std::f64::consts::PI * 0.1_f64.powi(2) / 4.0,
        1e-9,
    );
    near(
        result.peak_compressive_stress_mpa,
        1e6 * std::f64::consts::PI * 0.1_f64.powi(2) / 4.0 / 100.0,
        1e-9,
    );
    assert_eq!(result.peak_tensile_stress_mpa, 0.0);
    assert_eq!(result.peak_tensile_angle_deg, None);
    assert_eq!(result.status, "not-evaluated");
    assert_eq!(result.fatigue.status, "not-evaluated");
    assert_eq!(result.fatigue.damage_fraction, None);
}

#[test]
fn gas_and_inertia_are_combined_at_the_same_crank_angle() {
    let mut cycle = inertia_cycle();
    let omega = cycle.rpm * 2.0 * std::f64::consts::PI / 60.0;
    let r = cycle.stroke_m / 2.0;
    let area = std::f64::consts::PI * cycle.bore_m.powi(2) / 4.0;
    let tdc_inertia =
        cycle.reciprocating_mass_kg * r * omega.powi(2) * (1.0 + r / cycle.rod_length_m);
    cycle.pressure_pa = vec![
        101325.0 + tdc_inertia / area,
        101325.0,
        101325.0 + tdc_inertia / area,
        101325.0,
        101325.0 + tdc_inertia / area,
    ];
    let config = normalize_material_screen_config(&json!({"netSectionMm2":100})).unwrap();
    let result = screen_material(&cycle, &config).unwrap();
    near(result.trace.rod_compression_force_n[0], 0.0, 1e-9);
    let maximum_rod = result
        .trace
        .rod_compression_force_n
        .iter()
        .fold(0.0_f64, |a, b| a.max(b.abs()));
    let independent_sum = result
        .trace
        .gas_force_n
        .iter()
        .fold(0.0_f64, |a, b| a.max(b.abs()))
        + result
            .trace
            .inertia_force_n
            .iter()
            .fold(0.0_f64, |a, b| a.max(b.abs()));
    assert!(maximum_rod < independent_sum * 0.6);
    let mut invalid = cycle.clone();
    invalid.rod_length_m = r;
    assert!(screen_material(&invalid, &config).is_err());
    invalid = cycle;
    invalid.angle_deg = vec![0.0, 180.0, 180.0, 540.0, 720.0];
    assert!(screen_material(&invalid, &config).is_err());
}

#[test]
fn slider_crank_inertia_matches_independent_position_finite_difference() {
    let angles = vec![0.0, 30.0, 90.0, 130.0, 180.0, 225.0, 360.0, 540.0, 720.0];
    let cycle = MechanicalCycleInput {
        pressure_pa: vec![101325.0; angles.len()],
        angle_deg: angles.clone(),
        reciprocating_mass_kg: 1.0,
        rpm: 60.0 / (2.0 * std::f64::consts::PI),
        ..inertia_cycle()
    };
    let result = screen_material(&cycle, &Default::default()).unwrap();
    let (r, l, h) = (cycle.stroke_m / 2.0, cycle.rod_length_m, 1e-4);
    let position =
        |theta: f64| r * (1.0 - theta.cos()) + l - (l * l - r * r * theta.sin().powi(2)).sqrt();
    for (i, angle) in angles.iter().enumerate() {
        let theta = angle * std::f64::consts::PI / 180.0;
        let second = (position(theta + h) - 2.0 * position(theta) + position(theta - h)) / (h * h);
        near(result.trace.inertia_force_n[i], second, 1e-6);
    }
}

#[test]
fn allowable_interpolation_stays_inside_the_supplied_temperature_domain() {
    let mut input = json!({"material":card(),"netSectionMm2":100,"componentTemperatureK":343.15});
    let result = screen_material(
        &static_cycle(),
        &normalize_material_screen_config(&input).unwrap(),
    )
    .unwrap();
    near(result.allowable_stress_mpa.unwrap(), 90.0, 1e-9);
    assert_eq!(result.status, "within-card");
    input["componentTemperatureK"] = json!(450);
    let result = screen_material(
        &static_cycle(),
        &normalize_material_screen_config(&input).unwrap(),
    )
    .unwrap();
    assert_eq!(result.status, "not-evaluated");
    assert_eq!(result.allowable_stress_mpa, None);
    input["componentTemperatureK"] = json!(343.15);
    input["netSectionMm2"] = json!(50);
    assert_eq!(
        screen_material(
            &static_cycle(),
            &normalize_material_screen_config(&input).unwrap()
        )
        .unwrap()
        .status,
        "exceeds-card"
    );
}

#[test]
fn fatigue_requires_matching_amplitude_temperature_and_stress_ratio() {
    let cycle = inertia_cycle();
    let omega = cycle.rpm * 2.0 * std::f64::consts::PI / 60.0;
    let r = cycle.stroke_m / 2.0;
    let amplitude = cycle.reciprocating_mass_kg * r * omega.powi(2) / 100.0;
    let ratio = -(1.0 - r / cycle.rod_length_m) / (1.0 + r / cycle.rod_length_m);
    let mut material = card();
    material["fatigueCurves"] = json!([{"temperatureK":343.15,"temperatureToleranceK":1,"stressRatio":ratio,"stressRatioTolerance":0.001,"conditions":"Synthetic constant-amplitude fixture at stated R and temperature","points":[{"stressAmplitudeMPa":20,"cycles":1e7},{"stressAmplitudeMPa":40,"cycles":1e5}]}]);
    let mut input = json!({"material":material,"netSectionMm2":100,"componentTemperatureK":343.15,"durationSeconds":60,"cyclesPerEngineCycle":1});
    let result =
        screen_material(&cycle, &normalize_material_screen_config(&input).unwrap()).unwrap();
    let weight = (amplitude / 20.0).ln() / (40.0_f64 / 20.0).ln();
    let expected = (1e7_f64.ln() + (1e5_f64.ln() - 1e7_f64.ln()) * weight).exp();
    near(result.stress_amplitude_mpa, amplitude, 1e-9);
    near(result.stress_ratio.unwrap(), ratio, 1e-9);
    assert_eq!(result.fatigue.status, "evaluated");
    near(result.fatigue.cycles_at_amplitude.unwrap(), expected, 1e-9);
    near(result.fatigue.applied_envelope_cycles, 1500.0, 1e-9);
    near(
        result.fatigue.damage_fraction.unwrap(),
        1500.0 / expected,
        1e-9,
    );
    input["componentTemperatureK"] = json!(350);
    assert_eq!(
        screen_material(&cycle, &normalize_material_screen_config(&input).unwrap())
            .unwrap()
            .fatigue
            .status,
        "not-evaluated"
    );
    input["componentTemperatureK"] = json!(343.15);
    input["netSectionMm2"] = json!(1000);
    assert_eq!(
        screen_material(&cycle, &normalize_material_screen_config(&input).unwrap())
            .unwrap()
            .fatigue
            .status,
        "not-evaluated"
    );
    input["netSectionMm2"] = json!(100);
    input["material"]["fatigueCurves"][0]["stressRatio"] = json!(-1);
    assert_eq!(
        screen_material(&cycle, &normalize_material_screen_config(&input).unwrap())
            .unwrap()
            .fatigue
            .status,
        "not-evaluated"
    );
}

#[test]
fn malformed_life_tables_and_nonfinite_direct_rust_inputs_are_rejected() {
    let mut material = card();
    material["fatigueCurves"] = json!([{"temperatureK":300,"temperatureToleranceK":0,"stressRatio":-1,"stressRatioTolerance":0,"conditions":"Fixture","points":[{"stressAmplitudeMPa":10,"cycles":10},{"stressAmplitudeMPa":20,"cycles":20}]}]);
    assert!(parse_material_card(&material).is_err());
    let mut cycle = static_cycle();
    cycle.pressure_pa[1] = f64::NAN;
    assert!(screen_material(&cycle, &Default::default()).is_err());
    cycle = static_cycle();
    cycle.rpm = f64::INFINITY;
    assert!(screen_material(&cycle, &Default::default()).is_err());
}

#[test]
fn json_surface_preserves_the_existing_mpa_acronyms() {
    let material = parse_material_card(&card()).unwrap();
    let serialized = serde_json::to_value(material).unwrap();
    assert!(serialized.get("allowableStressMPa").is_some());
    assert!(serialized.get("allowableStressMpa").is_none());
    let result =
        serde_json::to_value(screen_material(&static_cycle(), &Default::default()).unwrap())
            .unwrap();
    assert!(result.get("maximumAbsoluteStressMPa").is_some());
    assert!(result["trace"].get("stressMPa").is_some());
}
