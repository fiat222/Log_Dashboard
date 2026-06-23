package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	serviceName = "admission_admission-wp"
	maxReplicas = 10
	minReplicas = 1
	port        = "5000"
	cooldownSec = 5
)

var (
	lastScale time.Time
	mu        sync.Mutex
	logger    *log.Logger
)

type AlertPayload struct {
	Alerts []struct {
		Status string `json:"status"`
		Labels struct {
			Action string `json:"action"`
			Step   string `json:"step"`
		} `json:"labels"`
	} `json:"alerts"`
}

func main() {

	logger = log.New(os.Stdout, "", log.LstdFlags)

	http.HandleFunc("/scale", webhookHandler)

	logger.Printf("Autoscaler started on :%s", port)

	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func webhookHandler(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()

	var payload AlertPayload

	err := json.NewDecoder(r.Body).Decode(&payload)
	if err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	action := ""
	step := 1

	for _, alert := range payload.Alerts {

		if alert.Status != "firing" {
			continue
		}

		action = alert.Labels.Action

		if alert.Labels.Step != "" {

			parsedStep, err := strconv.Atoi(alert.Labels.Step)
			if err == nil && parsedStep > 0 {
				step = parsedStep
			}
		}

		break
	}

	if action == "" {
		w.Write([]byte("no action"))
		return
	}

	mu.Lock()
	defer mu.Unlock()

	if time.Since(lastScale) < cooldownSec*time.Second {
		logger.Println("Cooldown active")
		w.Write([]byte("cooldown"))
		return
	}

	current, err := getReplicas()
	if err != nil {
		logger.Printf("Failed to get replicas: %v", err)
		http.Error(w, "failed to get replicas", 500)
		return
	}

	switch action {

	case "scale_up":

		newReplicas := current + step

		if newReplicas > maxReplicas {
			newReplicas = maxReplicas
		}

		if newReplicas == current {
			logger.Println("Already at MAX replicas")
			w.Write([]byte("max replicas reached"))
			return
		}

		logger.Printf(
			"Scale UP %d -> %d (step=%d)",
			current,
			newReplicas,
			step,
		)

		err = scale(newReplicas)
		if err != nil {
			logger.Printf("Scale up failed: %v", err)
			http.Error(w, "scale failed", 500)
			return
		}

		lastScale = time.Now()

	case "scale_down":

		newReplicas := current - step

		if newReplicas < minReplicas {
			newReplicas = minReplicas
		}

		if newReplicas == current {
			logger.Println("Already at MIN replicas")
			w.Write([]byte("min replicas reached"))
			return
		}

		logger.Printf(
			"Scale DOWN %d -> %d (step=%d)",
			current,
			newReplicas,
			step,
		)

		err = scale(newReplicas)
		if err != nil {
			logger.Printf("Scale down failed: %v", err)
			http.Error(w, "scale failed", 500)
			return
		}

		lastScale = time.Now()

	default:
		w.Write([]byte("unknown action"))
		return
	}

	w.Write([]byte("ok"))
}

func getReplicas() (int, error) {

	cmd := exec.Command(
		"docker",
		"service",
		"inspect",
		serviceName,
		"--format",
		"{{.Spec.Mode.Replicated.Replicas}}",
	)

	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}

	replicas, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		return 0, err
	}

	return replicas, nil
}

func scale(replicas int) error {

	cmd := exec.Command(
		"docker",
		"service",
		"scale",
		fmt.Sprintf("%s=%d", serviceName, replicas),
	)

	output, err := cmd.CombinedOutput()

	logger.Printf("docker output: %s", string(output))

	return err
}