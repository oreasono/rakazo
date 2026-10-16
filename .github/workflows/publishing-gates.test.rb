# Offline YAML and publishing-condition regression checks; no GitHub calls or credentials.
require "minitest/autorun"
require "strscan"
require "yaml"

# Evaluate only the string comparisons and boolean operators used by these job gates.
# Unknown syntax fails instead of evaluating workflow text as Ruby code.
class PublishingCondition
  def initialize(expression, context)
    scanner = StringScanner.new(expression)
    @tokens = []
    until scanner.eos?
      next if scanner.scan(/\s+/)
      token = scanner.scan(/&&|\|\||==|!=|[()]|'[^']*'|(?:github|vars)\.[A-Za-z_]+/)
      raise "Unsupported job condition syntax" unless token
      @tokens << token
    end
    @context = context
  end

  def enabled?
    value = disjunction
    raise "Unconsumed job condition tokens" unless @tokens.empty?
    raise "Job condition must evaluate to boolean" unless [true, false].include?(value)
    value
  end

  private

  def disjunction
    value = conjunction
    while @tokens.first == "||"
      @tokens.shift
      right = conjunction
      value = value || right
    end
    value
  end

  def conjunction
    value = comparison
    while @tokens.first == "&&"
      @tokens.shift
      right = comparison
      value = value && right
    end
    value
  end

  def comparison
    left = atom
    return left unless ["==", "!="].include?(@tokens.first)
    operator = @tokens.shift
    right = atom
    # GitHub expressions compare strings without case sensitivity.
    equal = left.to_s.casecmp?(right.to_s)
    operator == "==" ? equal : !equal
  end

  def atom
    token = @tokens.shift
    if token == "("
      value = disjunction
      raise "Unclosed job condition" unless @tokens.shift == ")"
      return value
    end
    return token[1...-1] if token&.start_with?("'")
    return @context.fetch(token, "") if token&.match?(/\A(?:github|vars)\.[A-Za-z_]+\z/)
    raise "Missing job condition operand"
  end
end

class PublishingGatesTest < Minitest::Test
  DIRECTORY = File.expand_path(__dir__)
  UPSTREAM = "elie222/rakazo"
  TEST_JOBS = %w[lint check build test test-integration test-e2e].freeze

  def workflow(name)
    YAML.safe_load(File.read(File.join(DIRECTORY, name)), aliases: true)
  end

  def allowed?(job, repository, event, ref, variables = {})
    context = { "github.repository" => repository, "github.event_name" => event, "github.ref" => ref }
    variables.each { |key, value| context["vars.#{key}"] = value }
    PublishingCondition.new(job.fetch("if"), context).enabled?
  end

  def test_all_workflow_yaml_parses_and_pr_triggers_remain
    Dir[File.join(DIRECTORY, "*.yml")].each do |file|
      document = workflow(File.basename(file))
      assert_kind_of Hash, document.fetch("jobs"), File.basename(file)
    end
    %w[ci.yml publish-server-image.yml].each do |name|
      document = workflow(name)
      # Psych's YAML 1.1 loader parses the unquoted GitHub key `on` as true.
      assert (document["on"] || document[true]).key?("pull_request"), name
    end
  end

  def test_server_build_and_manifest_publication_require_fork_opt_in
    jobs = workflow("publish-server-image.yml").fetch("jobs")
    %w[build publish].each do |name|
      [UPSTREAM, "example/rakazo", "elie222/another-repo"].product(
        ["", "false", "true", "TRUE", "1"],
        %w[push pull_request workflow_dispatch],
        %w[refs/heads/main refs/tags/v1.0.0 refs/heads/topic]
      ).each do |repository, flag, event, ref|
        expected = event != "pull_request" && (repository == UPSTREAM || flag.casecmp?("true"))
        assert_equal expected, allowed?(jobs.fetch(name), repository, event, ref, "SERVER_IMAGE_PUBLISH_ENABLED" => flag), [name, repository, flag, event, ref].inspect
      end
      refute allowed?(jobs.fetch(name), "example/rakazo", "push", "refs/heads/main", "MOBILE_OTA_PUBLISH_ENABLED" => "true")
    end
  end

  def test_mobile_ota_preserves_main_only_and_upstream_behavior
    job = workflow("ci.yml").fetch("jobs").fetch("publish-mobile-update")
    [UPSTREAM, "example/rakazo"].product(
      ["", "false", "true", "TRUE", "1"], %w[push pull_request workflow_dispatch],
      %w[refs/heads/main refs/tags/v1.0.0 refs/heads/topic]
    ).each do |repository, flag, event, ref|
      expected = event == "push" && ref == "refs/heads/main" && (repository == UPSTREAM || flag.casecmp?("true"))
      assert_equal expected, allowed?(job, repository, event, ref, "MOBILE_OTA_PUBLISH_ENABLED" => flag), [repository, flag, event, ref].inspect
    end
    refute allowed?(job, "example/rakazo", "push", "refs/heads/main", "SERVER_IMAGE_PUBLISH_ENABLED" => "true")
    assert_equal TEST_JOBS.sort, job.fetch("needs").sort
  end

  def test_deployment_stays_explicitly_opt_in_even_on_upstream
    job = workflow("ci.yml").fetch("jobs").fetch("deploy-production")
    [UPSTREAM, "example/rakazo"].product(
      ["", "false", "true"], %w[push pull_request workflow_dispatch],
      %w[refs/heads/main refs/heads/topic]
    ).each do |repository, flag, event, ref|
      expected = flag == "true" && event == "push" && ref == "refs/heads/main"
      assert_equal expected, allowed?(job, repository, event, ref, "PRODUCTION_DEPLOY_ENABLED" => flag)
    end
    refute allowed?(job, "example/rakazo", "push", "refs/heads/main", "SERVER_IMAGE_PUBLISH_ENABLED" => "true", "MOBILE_OTA_PUBLISH_ENABLED" => "true")
    assert_equal TEST_JOBS.sort, job.fetch("needs").sort
  end

  def test_pr_builds_and_tests_do_not_depend_on_publication_flags
    TEST_JOBS.each { |name| assert_nil workflow("ci.yml").fetch("jobs").fetch(name)["if"] }
    jobs = workflow("publish-server-image.yml").fetch("jobs")
    %w[validate installer-smoke].each do |name|
      assert allowed?(jobs.fetch(name), "example/rakazo", "pull_request", "refs/pull/1/merge")
      assert_equal({ "contents" => "read" }, jobs.fetch(name).fetch("permissions"))
    end
    build = jobs.fetch("validate").fetch("steps").find { |step| step["uses"]&.start_with?("docker/build-push-action@") }
    assert_equal false, build.fetch("with").fetch("push")
  end
end
