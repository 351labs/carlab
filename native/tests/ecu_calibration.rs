use carlab_engine_lab::config::EngineConfig;
use carlab_engine_lab::ecu::{CombustionMode, EcuConfig, EcuMapKind};
use carlab_engine_lab::ecu_calibration::*;
use carlab_engine_lab::powertrain::{
    ControlledPointOverrides, PhysicalConfig, evaluate_controlled_point,
    evaluate_controlled_point_with_overrides,
};
use serde_json::{Value, json};

fn options() -> EcuFitOptions {
    EcuFitOptions {
        source: EcuObservationSource {
            kind: "simulated".into(),
            label: "Original synthetic calibration test".into(),
            fingerprint: "synthetic-fixture-1".into(),
            conditions: "No real engine data; warm steady proportional delivery".into(),
        },
        regularization: 1e-8,
        iterations: 64,
    }
}
fn observation(rpm: f64, map_bar: f64, lambda: f64) -> EcuLambdaObservation {
    EcuLambdaObservation {
        rpm,
        map_bar,
        observed_lambda: lambda,
        valid: true,
        steady: true,
        capture_session_id: "training-session".into(),
        ..Default::default()
    }
}
fn matrix(config: &EcuConfig, lambda: f64) -> Vec<EcuLambdaObservation> {
    config
        .fuel_correction_map
        .rpm
        .iter()
        .flat_map(|&r| {
            config
                .fuel_correction_map
                .pressure_bar
                .iter()
                .map(move |&p| observation(r, p, lambda))
        })
        .collect()
}
fn near(a: f64, b: f64, tolerance: f64) {
    assert!((a - b).abs() <= tolerance * b.abs().max(1.0), "{a} != {b}");
}
fn physical(engine: &EngineConfig) -> PhysicalConfig {
    PhysicalConfig::from_value(engine,&json!({"ecu":{"enabled":true},"assumedPeakPressureBar":1000,"assumedMeanPistonSpeedMs":200})).unwrap()
}
fn search_options() -> EcuSearchOptions {
    EcuSearchOptions {
        lambda_bounds: [0.9, 1.1],
        spark_bounds: [12.0, 24.0],
        lambda_steps: 3,
        spark_steps: 3,
        budget: 9,
        refinement_levels: 0,
        max_duty_fraction: 1.0,
        max_pressure_bar: Some(1000.0),
        max_mean_piston_speed_ms: Some(200.0),
        ..Default::default()
    }
}

#[test]
fn fit_corrects_steady_lambda_and_preserves_target_ve_and_configuration() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let before = serde_json::to_value(&config).unwrap();
    let rows = matrix(&config, 1.2);
    let fit = fit_ecu_fuel_map(&engine, &config, &rows, &options()).unwrap();
    assert_eq!(fit.map.kind, EcuMapKind::FuelCorrection);
    for value in fit.map.values.iter().flatten() {
        near(*value, 1.2, 1e-7);
    }
    assert_eq!(serde_json::to_value(&config).unwrap(), before);
    assert_eq!(fit.map.provenance.source, "fitted");
    assert_eq!(fit.source.kind, "simulated");
    assert!(fit.training.after_rmse_lambda.unwrap() < 1e-7);
    assert_eq!(fit.coverage.supported_nodes, fit.coverage.total_nodes);
    assert_eq!(fit.validation.status, "not-evaluated");
    assert_eq!(fit.validation.after_rmse_lambda, None);
    assert!(!fit.independent_validation);
}

#[test]
fn known_closed_loop_total_multiplier_is_identified_even_when_lambda_is_on_target() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let mut row = observation(
        config.fuel_correction_map.rpm[0],
        config.fuel_correction_map.pressure_bar[0],
        1.0,
    );
    row.closed_loop_active = true;
    row.applied_fuel_multiplier = Some(1.2);
    let fit = fit_ecu_fuel_map(&engine, &config, &[row.clone()], &options()).unwrap();
    near(fit.map.values[0][0], 1.2, 1e-7);
    near(fit.training.observed_rmse_lambda.unwrap(), 0.0, 1e-12);
    near(fit.training.before_rmse_lambda.unwrap(), 0.2, 1e-12);
    assert!(fit.training.after_rmse_lambda.unwrap() < 1e-7);
    row.applied_fuel_multiplier = None;
    assert!(fit_ecu_fuel_map(&engine, &config, &[row], &options()).is_err());
}

#[test]
fn held_out_values_do_not_leak_into_fitting_and_partial_support_remains_partial() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let first = observation(
        config.fuel_correction_map.rpm[0],
        config.fuel_correction_map.pressure_bar[0],
        1.2,
    );
    let mut holdout = first.clone();
    holdout.split = "validation".into();
    holdout.observed_lambda = 2.0;
    let a = fit_ecu_fuel_map(
        &engine,
        &config,
        &[first.clone(), holdout.clone()],
        &options(),
    )
    .unwrap();
    holdout.observed_lambda = 0.8;
    let b = fit_ecu_fuel_map(&engine, &config, &[first, holdout], &options()).unwrap();
    assert_eq!(a.map.values, b.map.values);
    assert_ne!(
        a.validation.after_rmse_lambda,
        b.validation.after_rmse_lambda
    );
    assert_eq!(a.coverage.supported_nodes, 1);
    assert_eq!(a.map.values[1][1], config.fuel_correction_map.values[1][1]);
    assert!(!a.independent_validation);
    assert_eq!(a.validation_status, "not-independent");
    assert_eq!(a.coverage.validation_condition_overlap, 1);
    assert_eq!(a.coverage.validation_session_overlap, 1);
}

#[test]
fn distinct_roles_do_not_make_adjacent_or_unknown_session_samples_independent() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let train = observation(2000.0, 0.5, 1.1);
    let mut holdout = observation(2001.0, 0.501, 1.1);
    holdout.split = "validation".into();
    holdout.capture_session_id = "separate-session".into();
    let fit = fit_ecu_fuel_map(
        &engine,
        &config,
        &[train.clone(), holdout.clone()],
        &options(),
    )
    .unwrap();
    assert_eq!(fit.coverage.validation_condition_overlap, 0);
    assert_eq!(fit.coverage.validation_cell_overlap, 1);
    assert!(!fit.independent_validation);
    holdout.capture_session_id.clear();
    let fit = fit_ecu_fuel_map(&engine, &config, &[train, holdout], &options()).unwrap();
    assert_eq!(fit.coverage.unknown_session_samples, 1);
    assert!(!fit.independent_validation);
}

#[test]
fn cuts_invalidity_saturation_transients_warmup_and_domain_mismatch_are_rejected() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let valid = observation(3000.0, 0.7, 1.1);
    let mut rows = vec![valid.clone()];
    for flag in [
        "valid",
        "steady",
        "injectorCut",
        "combustionCut",
        "saturated",
        "transient",
        "warmup",
    ] {
        let mut value = serde_json::to_value(&valid).unwrap();
        value[flag] = json!(!matches!(flag, "valid" | "steady"));
        rows.push(serde_json::from_value(value).unwrap());
    }
    let mut invalid = valid.clone();
    invalid.rpm = 50.0;
    rows.push(invalid);
    let mut invalid = valid.clone();
    invalid.target_lambda = Some(0.75);
    rows.push(invalid);
    let mut invalid = valid.clone();
    invalid.closed_loop_active = true;
    rows.push(invalid);
    let mut invalid = valid.clone();
    invalid.observed_lambda = f64::NAN;
    rows.push(invalid);
    let fit = fit_ecu_fuel_map(&engine, &config, &rows, &options()).unwrap();
    assert_eq!(fit.coverage.training_samples, 1);
    assert_eq!(fit.rejected.len(), rows.len() - 1);
    assert!(
        fit.rejected
            .iter()
            .any(|r| r.reasons.contains(&"outside-controller-map-domain".into()))
    );
    assert!(fit.rejected.iter().any(|r| {
        r.reasons
            .contains(&"closed-loop-applied-multiplier-missing".into())
    }));
}

#[test]
fn fit_requires_training_and_declared_provenance_and_reports_bounded_solutions() {
    let engine = EngineConfig::default();
    let mut config = EcuConfig::default_for(&engine);
    let mut validation = observation(3000.0, 0.7, 1.1);
    validation.split = "validation".into();
    assert!(fit_ecu_fuel_map(&engine, &config, &[validation], &options()).is_err());
    assert!(
        fit_ecu_fuel_map(
            &engine,
            &config,
            &matrix(&config, 1.1),
            &EcuFitOptions::default()
        )
        .is_err()
    );
    for row in &mut config.lambda_target_map.values {
        for value in row {
            *value = 0.65;
        }
    }
    let row = observation(
        config.fuel_correction_map.rpm[0],
        config.fuel_correction_map.pressure_bar[0],
        10.0,
    );
    let fit = fit_ecu_fuel_map(&engine, &config, &[row], &options()).unwrap();
    assert_eq!(fit.map.values[0][0], 4.0);
    assert_eq!(fit.bounded_nodes, 1);
    assert!(fit.training.after_rmse_lambda.unwrap() > 0.1);
}

#[test]
fn search_rejects_unsupported_required_evidence_and_disabled_or_invalid_inputs() {
    let engine = EngineConfig::default();
    let physical = physical(&engine);
    for evidence in ["knock", "emissions", "materialLife"] {
        let options = EcuSearchOptions {
            required_evidence: vec![evidence.into()],
            ..search_options()
        };
        assert!(
            search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options)
                .unwrap_err()
                .contains("unsupported")
        );
    }
    assert!(
        search_ecu_operating_point(
            &engine,
            &PhysicalConfig::default_for(&engine),
            3000.0,
            0.6,
            &search_options()
        )
        .is_err()
    );
    let options = EcuSearchOptions {
        lambda_bounds: [1.2, 0.8],
        ..search_options()
    };
    assert!(search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).is_err());
    let options = EcuSearchOptions {
        objective: "minFuelAtTorque".into(),
        ..search_options()
    };
    assert!(search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).is_err());
}

#[test]
fn search_candidates_are_actual_actuator_cylinder_evaluations_with_a_hard_budget() {
    let engine = EngineConfig::default();
    let physical = physical(&engine);
    let options = search_options();
    let result = search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).unwrap();
    assert_eq!(result.evaluated, 9);
    assert!(
        result.candidates.iter().any(|c| c.feasible),
        "No feasible representative points: {:?}",
        result.candidates
    );
    for candidate in &result.candidates {
        let point = evaluate_controlled_point(
            &engine,
            &physical,
            3000.0,
            0.6,
            candidate.lambda_target,
            candidate.spark_advance_deg,
        )
        .unwrap();
        near(candidate.torque_nm.unwrap(), point.torque_nm, 1e-12);
        near(
            candidate.fuel_mass_flow_kgs.unwrap(),
            point.fuel_mass_flow_kgs,
            1e-12,
        );
        assert_eq!(
            candidate.actual_lambda,
            point.ecu.as_ref().unwrap().plant_lambda
        );
    }
    assert_eq!(result.unsupported_constraints.len(), 3);
    assert!(
        result
            .unsupported_constraints
            .iter()
            .all(|c| c.status == "not-evaluated")
    );
    assert_eq!(result.status, "model-only-candidates");
}

#[test]
fn refinement_is_reproducible_deduplicated_and_cannot_exceed_its_evaluation_budget() {
    let engine = EngineConfig::default();
    let physical = physical(&engine);
    let options = EcuSearchOptions {
        budget: 13,
        refinement_levels: 2,
        ..search_options()
    };
    let a = search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).unwrap();
    let b = search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).unwrap();
    assert_eq!(
        serde_json::to_value(&a).unwrap(),
        serde_json::to_value(&b).unwrap()
    );
    assert!(a.evaluated <= 13);
    assert!(a.evaluated >= 9);
    let mut pairs = a
        .candidates
        .iter()
        .map(|c| {
            (
                c.lambda_target.unwrap().to_bits(),
                c.spark_advance_deg.unwrap().to_bits(),
            )
        })
        .collect::<Vec<_>>();
    pairs.sort();
    pairs.dedup();
    assert_eq!(pairs.len(), a.evaluated);
    for id in &a.pareto_ids {
        assert!(a.candidates[*id].feasible);
    }
}

#[test]
fn fuel_objective_holds_requested_torque_and_reports_bsfc_in_coherent_units() {
    let engine = EngineConfig::default();
    let physical = physical(&engine);
    let point =
        evaluate_controlled_point(&engine, &physical, 3000.0, 0.6, Some(1.0), Some(18.0)).unwrap();
    let options = EcuSearchOptions {
        objective: "minFuelAtTorque".into(),
        requested_torque_nm: Some(point.torque_nm),
        torque_tolerance_nm: 0.1,
        ..search_options()
    };
    let result = search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).unwrap();
    let selected = &result.candidates[result
        .selected_id
        .expect("The exact requested reference condition is in the grid")];
    assert!((selected.torque_nm.unwrap() - point.torque_nm).abs() <= 0.1);
    near(
        selected.bsfc_gkwh.unwrap(),
        selected.fuel_mass_flow_kgs.unwrap() * 1000.0 * 3600.0 / selected.power_kw.unwrap(),
        1e-12,
    );
}

#[test]
fn assumed_constraint_failure_returns_no_feasible_optimum_instead_of_a_fake_safe_result() {
    let engine = EngineConfig::default();
    let physical = physical(&engine);
    let options = EcuSearchOptions {
        max_pressure_bar: Some(0.01),
        ..search_options()
    };
    let result = search_ecu_operating_point(&engine, &physical, 3000.0, 0.6, &options).unwrap();
    assert_eq!(result.status, "no-feasible-candidate");
    assert_eq!(result.selected_id, None);
    assert!(result.pareto_ids.is_empty());
    assert!(result.candidates.iter().all(|c| !c.feasible));
    assert!(result.candidates.iter().any(|c| {
        c.constraints.iter().any(|r| {
            r.name == "peak-pressure"
                && r.status == "violated"
                && r.source.contains("Owner-assumed")
        })
    }));
}

#[test]
fn serialized_fit_surface_retains_controller_source_and_group_coverage_metadata() {
    let engine = EngineConfig::default();
    let config = EcuConfig::default_for(&engine);
    let fit = fit_ecu_fuel_map(&engine, &config, &matrix(&config, 1.1), &options()).unwrap();
    let value = serde_json::to_value(fit).unwrap();
    assert_eq!(value["source"]["kind"], "simulated");
    assert_eq!(value["independentValidation"], false);
    assert!(value["coverage"].get("supportedNodeIndices").is_some());
    assert!(value["training"].get("observedRmseLambda").is_some());
    assert_eq!(value["validation"]["afterRmseLambda"], Value::Null);
}

#[test]
fn independent_split_requires_declared_separate_sessions_and_entire_map_cells() {
    let engine = EngineConfig::default();
    let mut config = EcuConfig::default_for(&engine);
    config.fuel_correction_map.rpm = vec![1000.0, 3000.0, 5000.0];
    config.fuel_correction_map.pressure_bar = vec![0.1, 0.7, 1.3];
    config.fuel_correction_map.values = vec![vec![1.0; 3]; 3];
    let train = observation(1000.0, 0.1, 1.2);
    let mut validation = observation(5000.0, 1.3, 1.1);
    validation.split = "validation".into();
    validation.capture_session_id = "later-held-out-session".into();
    let result = fit_ecu_fuel_map(&engine, &config, &[train, validation], &options()).unwrap();
    assert!(result.independent_validation);
    assert_eq!(result.validation_status, "declared-disjoint");
    assert_eq!(result.coverage.validation_condition_overlap, 0);
    assert_eq!(result.coverage.validation_cell_overlap, 0);
    assert_eq!(result.coverage.validation_session_overlap, 0);
    // Withheld unsupported nodes remain baseline, so independence does not mean
    // the fitted model passed validation or imply that measured provenance is verified.
    assert_eq!(result.map.values[2][2], 1.0);
    near(result.validation.after_rmse_lambda.unwrap(), 0.1, 1e-12);
    assert!(
        result
            .validation_warnings
            .iter()
            .any(|w| w.contains("caller-declared"))
    );
}

fn diesel_physical(engine: &EngineConfig) -> PhysicalConfig {
    PhysicalConfig::from_value(engine,&json!({"ecu":{"enabled":true,"combustionMode":"directInjectionDiesel"},"assumedPeakPressureBar":1000,"assumedMeanPistonSpeedMs":200})).unwrap()
}
fn diesel_options() -> EcuSearchOptions {
    EcuSearchOptions {
        diesel_quantity_min_mg: Some(8.0),
        diesel_quantity_max_mg: Some(14.0),
        injection_advance_min_deg: Some(6.0),
        injection_advance_max_deg: Some(18.0),
        diesel_quantity_steps: Some(3),
        injection_advance_steps: Some(3),
        budget: 9,
        refinement_levels: 0,
        max_duty_fraction: 1.0,
        max_pressure_bar: Some(1000.0),
        max_mean_piston_speed_ms: Some(200.0),
        ..Default::default()
    }
}

#[test]
fn diesel_fit_is_explicitly_unsupported_instead_of_reusing_si_lambda_inversion() {
    let engine = EngineConfig::default();
    let mut config = EcuConfig::default_for(&engine);
    config.combustion_mode = CombustionMode::DirectInjectionDiesel;
    let error = fit_ecu_fuel_map(&engine, &config, &matrix(&config, 1.2), &options()).unwrap_err();
    assert!(error.contains("Diesel fuel-correction fitting is not supported"));
    assert!(error.contains("SI lambda inversion"));
}

#[test]
fn mode_incompatible_search_axes_are_rejected_in_both_directions() {
    let engine = EngineConfig::default();
    assert!(
        search_ecu_operating_point(&engine, &physical(&engine), 3000.0, 0.6, &diesel_options())
            .unwrap_err()
            .contains("invalid for a spark")
    );
    assert!(
        search_ecu_operating_point(
            &engine,
            &diesel_physical(&engine),
            3000.0,
            0.6,
            &search_options()
        )
        .unwrap_err()
        .contains("SI lambda/spark axes")
    );
    let invalid = EcuSearchOptions {
        diesel_quantity_max_mg: Some(501.0),
        ..diesel_options()
    };
    assert!(
        search_ecu_operating_point(&engine, &diesel_physical(&engine), 3000.0, 0.6, &invalid)
            .is_err()
    );
}

#[test]
fn diesel_search_uses_requested_quantity_and_soi_through_the_real_actuator_and_pressure_cycle() {
    let mut engine = EngineConfig::default();
    engine.compression = 16.0;
    let physical = diesel_physical(&engine);
    let result =
        search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &diesel_options()).unwrap();
    assert_eq!(result.mode, "directInjectionDiesel");
    assert_eq!(result.evaluated, 9);
    assert!(result.axis_labels[0].contains("mg/cylinder"));
    assert!(
        result.candidates.iter().any(|c| c.feasible),
        "No feasible CI representative candidates: {:?}",
        result.candidates
    );
    for candidate in &result.candidates {
        assert_eq!(candidate.mode, "directInjectionDiesel");
        assert_eq!(candidate.lambda_target, None);
        assert_eq!(candidate.spark_advance_deg, None);
        let point = evaluate_controlled_point_with_overrides(
            &engine,
            &physical,
            3000.0,
            0.4,
            &ControlledPointOverrides {
                target_lambda: None,
                spark_advance_deg: None,
                diesel_quantity_mg_per_cylinder: candidate.diesel_quantity_mg,
                injection_start_deg_btdc: candidate.injection_advance_deg,
            },
        )
        .unwrap();
        let ecu = point.ecu.as_ref().unwrap();
        near(
            ecu.state.requested_fuel_mg_per_cylinder_cycle,
            candidate.diesel_quantity_mg.unwrap(),
            1e-12,
        );
        near(candidate.torque_nm.unwrap(), point.torque_nm, 1e-12);
        near(
            candidate.fuel_mass_flow_kgs.unwrap(),
            point.fuel_mass_flow_kgs,
            1e-12,
        );
        near(
            candidate.actual_quantity_mg.unwrap(),
            ecu.state.delivered_fuel_mg_per_cylinder_cycle,
            1e-12,
        );
        assert_eq!(candidate.minimum_lambda, ecu.state.minimum_lambda);
        assert!(
            candidate
                .constraints
                .iter()
                .any(|c| c.name == "diesel-minimum-lambda-proxy")
        );
    }
    let low = result
        .candidates
        .iter()
        .find(|c| c.diesel_quantity_mg == Some(8.0) && c.injection_advance_deg == Some(12.0))
        .unwrap();
    let high = result
        .candidates
        .iter()
        .find(|c| c.diesel_quantity_mg == Some(14.0) && c.injection_advance_deg == Some(12.0))
        .unwrap();
    assert!(high.torque_nm.unwrap() > low.torque_nm.unwrap());
    assert!(high.peak_pressure_bar.unwrap() > low.peak_pressure_bar.unwrap());
}

#[test]
fn diesel_minimum_lambda_comes_from_its_own_map_and_si_maps_do_not_shape_ci_results() {
    let mut engine = EngineConfig::default();
    engine.compression = 16.0;
    let mut physical = diesel_physical(&engine);
    let a = search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &diesel_options()).unwrap();
    for row in &mut physical.ecu.lambda_target_map.values {
        for value in row {
            *value = 0.65;
        }
    }
    for row in &mut physical.ecu.spark_advance_map.values {
        for value in row {
            *value = 48.0;
        }
    }
    let b = search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &diesel_options()).unwrap();
    for (a, b) in a.candidates.iter().zip(&b.candidates) {
        assert_eq!(a.torque_nm, b.torque_nm);
        assert_eq!(a.fuel_mass_flow_kgs, b.fuel_mass_flow_kgs);
    }
    for row in &mut physical.ecu.diesel.minimum_lambda_map.values {
        for value in row {
            *value = 3.5;
        }
    }
    let c = search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &diesel_options()).unwrap();
    for point in c.candidates {
        assert_eq!(point.minimum_lambda, Some(3.5));
        assert!(
            point
                .constraints
                .iter()
                .any(|c| c.name == "diesel-minimum-lambda-proxy" && c.limit == Some(3.5))
        );
    }
}

#[test]
fn diesel_search_report_options_are_replayable_without_inactive_si_axes() {
    let mut engine = EngineConfig::default();
    engine.compression = 16.0;
    let physical = diesel_physical(&engine);
    let a = search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &diesel_options()).unwrap();
    let serialized = serde_json::to_value(&a.options).unwrap();
    assert!(serialized.get("lambdaBounds").is_none());
    assert!(serialized.get("sparkBounds").is_none());
    assert!(serialized.get("lambdaSteps").is_none());
    assert!(serialized.get("sparkSteps").is_none());
    assert_eq!(serialized["dieselQuantityMinMg"], 8.0);
    assert_eq!(serialized["injectionAdvanceMaxDeg"], 18.0);
    let replay: EcuSearchOptions = serde_json::from_value(serialized).unwrap();
    let b = search_ecu_operating_point(&engine, &physical, 3000.0, 0.4, &replay).unwrap();
    assert_eq!(a.context_fingerprint, b.context_fingerprint);
    assert_eq!(
        serde_json::to_value(a.candidates).unwrap(),
        serde_json::to_value(b.candidates).unwrap()
    );
}
