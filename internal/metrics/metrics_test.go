package metrics

import (
	"fmt"
	"strings"
	"testing"
)

func gatherText(m *Metrics) (string, error) {
	families, err := m.registry.Gather()
	if err != nil {
		return "", err
	}
	var result strings.Builder
	for _, family := range families {
		if family.GetType().String() == "GAUGE" {
			for _, metric := range family.Metric {
				result.WriteString(fmt.Sprintf("%s %f\n", family.GetName(), metric.GetGauge().GetValue()))
			}
		}
	}
	return result.String(), nil
}

func TestMetricsClampCurrentCountsAndNeverExposeNegativeLiveGauge(t *testing.T) {
	m := NewMetrics()
	m.RecordStreamOffline()
	m.RecordViewers(-5)
	m.SetCurrentState(-2, -3)
	m.RecordStreamOffline()

	data, err := gatherText(m)
	if err != nil {
		t.Fatalf("gather metrics: %v", err)
	}
	if strings.Contains(data, "stremdbc_streams_live -") || strings.Contains(data, "stremdbc_viewers_total -") {
		t.Fatalf("negative gauge exported:\n%s", data)
	}
}

func TestSetCurrentStateReconcilesLiveGauge(t *testing.T) {
	m := NewMetrics()
	m.RecordStreamLive()
	m.RecordStreamLive()
	m.RecordStreamLive()
	m.RecordStreamOffline()
	m.SetCurrentState(5, 7)
	m.RecordStreamOffline()

	live := gaugeValue(t, m, "stremdbc_streams_live")
	if live != 4 {
		t.Fatalf("streams_live = %v, want 4 (SetCurrentState reseeds event counter)", live)
	}
	viewers := gaugeValue(t, m, "stremdbc_viewers_total")
	if viewers != 7 {
		t.Fatalf("viewers_total = %v, want 7", viewers)
	}
}

func gaugeValue(t *testing.T, m *Metrics, name string) float64 {
	t.Helper()
	fams, err := m.registry.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, fam := range fams {
		if fam.GetName() == name {
			for _, metric := range fam.GetMetric() {
				return metric.GetGauge().GetValue()
			}
		}
	}
	t.Fatalf("metric %q not found", name)
	return 0
}
