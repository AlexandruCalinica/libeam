defmodule GenStageBench.MixProject do
  use Mix.Project

  def project do
    [
      app: :gen_stage_bench,
      version: "0.1.0",
      elixir: "~> 1.15",
      start_permanent: false,
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [
      {:gen_stage, "~> 1.2"},
      {:benchee, "~> 1.3"}
    ]
  end
end
